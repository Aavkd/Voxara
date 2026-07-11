"""Local faster-whisper STT sidecar for llmtest (GPU, model loaded once).

Why this exists: the original STT path shelled out to whisper.cpp (CPU-only
build) once per utterance, reloading the 1.6GB model every call. On the dev
machine that measured ~32s to transcribe 7.4s of audio. faster-whisper
(CTranslate2) on CUDA float16 with the model kept resident does the same job in
~0.5-1s -- the exact setup the companion "Push to talk" app already proved fast
on this machine.

Design mirrors the Qwen3-TTS sidecar: the model is loaded exactly once behind a
lock, warmed up at startup, and /health reports real readiness so the client
never fires a request into a cold (downloading/loading) model.
"""

import io
import os
import threading
import time
import traceback
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

# CUDA/cuDNN DLLs must be discoverable before faster-whisper touches CTranslate2.
from _cuda import ensure_cuda_dll_path

ensure_cuda_dll_path()

from faster_whisper import WhisperModel  # noqa: E402  (after ensure_cuda_dll_path)


DEFAULT_MODEL = "large-v3-turbo"
# Lightest safe CPU fallback if the GPU cannot be used at all.
_CPU_FALLBACK_MODEL = "tiny"


def _model_target() -> str:
    return os.environ.get("VOICE_STT_MODEL", DEFAULT_MODEL)


def _device() -> str:
    return os.environ.get("FASTER_WHISPER_DEVICE", "cuda")


def _compute_type() -> str:
    return os.environ.get("FASTER_WHISPER_COMPUTE", "float16")


def _default_language() -> Optional[str]:
    lang = os.environ.get("VOICE_LANGUAGE", "fr").strip().lower()
    return lang or None


def _fallback_chain() -> list[tuple[str, str, str, Optional[str]]]:
    """Ordered (model, device, compute_type, reason) candidates.

    Try exactly what is configured first; on GPU, fall back to int8_float16
    (VRAM pressure) then to a light CPU model, so the service never hard-fails.
    """
    model = _model_target()
    device = _device()
    compute = _compute_type()

    chain: list[tuple[str, str, str, Optional[str]]] = [(model, device, compute, None)]
    if device == "cuda":
        if compute == "float16":
            chain.append((model, "cuda", "int8_float16", "vram"))
        chain.append((_CPU_FALLBACK_MODEL, "cpu", "int8", "cpu"))
    return chain


# ---------------------------------------------------------------------------
# Model lifecycle (single load, thread-safe, warmed up at startup)
# ---------------------------------------------------------------------------

_model: Optional[WhisperModel] = None
_load_lock = threading.Lock()
_infer_lock = threading.Lock()   # CTranslate2 model is not safe for concurrent calls
_state = "idle"                  # idle | loading | ready | error
_state_detail = ""
_loaded_with: Optional[tuple[str, str, str]] = None
_fallback: Optional[str] = None


def _load_model() -> WhisperModel:
    global _model, _state, _state_detail, _loaded_with, _fallback

    if _model is not None:
        return _model

    with _load_lock:
        if _model is not None:
            return _model

        cache_dir = os.environ.get("VOICE_STT_CACHE_DIR") or None
        cache_kwargs = {"download_root": cache_dir} if cache_dir else {}

        _state = "loading"
        _state_detail = "loading model (first run downloads weights)"
        last_exc: Optional[Exception] = None
        for model_name, device, compute_type, reason in _fallback_chain():
            print(f"[faster-whisper] loading {model_name} on {device} ({compute_type})", flush=True)
            t0 = time.perf_counter()
            try:
                model = WhisperModel(
                    model_name, device=device, compute_type=compute_type, **cache_kwargs
                )
            except Exception as exc:  # noqa: BLE001 - try the next candidate
                last_exc = exc
                print(
                    f"[faster-whisper] load failed {model_name}/{device}/{compute_type}: {exc}",
                    flush=True,
                )
                continue

            _model = model
            _loaded_with = (model_name, device, compute_type)
            _fallback = reason
            _state = "ready"
            elapsed = time.perf_counter() - t0
            suffix = {
                "vram": " (VRAM fallback: int8_float16)",
                "cpu": " (CPU fallback: GPU unavailable)",
            }.get(reason or "", "")
            _state_detail = f"{model_name} on {device} ({compute_type}){suffix}"
            print(f"[faster-whisper] model ready in {elapsed:.1f}s: {_state_detail}", flush=True)
            return _model

        _state = "error"
        _state_detail = f"no backend could load (last error: {last_exc})"
        print(f"[faster-whisper] {_state_detail}", flush=True)
        raise RuntimeError(_state_detail)


def _warmup() -> None:
    try:
        _load_model()
    except Exception:
        # Logged in _load_model; keep the server up so /health can report it.
        pass


class TranscribeRequest(BaseModel):
    language: Optional[str] = None
    beam_size: int = 5


app = FastAPI(title="Local faster-whisper STT wrapper for llmtest")


@app.on_event("startup")
def _on_startup() -> None:
    if os.environ.get("FASTER_WHISPER_WARMUP", "1").lower() not in ("0", "false", "no"):
        threading.Thread(target=_warmup, name="faster-whisper-warmup", daemon=True).start()


@app.get("/health")
def health():
    return {
        "ok": _state != "error",
        "ready": _state == "ready",
        "state": _state,
        "detail": _state_detail,
        "model": _model_target(),
        "device": _device(),
        "compute_type": _compute_type(),
        "loaded_with": list(_loaded_with) if _loaded_with else None,
        "fallback": _fallback,
    }


@app.post("/transcribe")
async def transcribe(request: Request):
    if _state == "error":
        raise HTTPException(status_code=500, detail=f"faster-whisper failed to load: {_state_detail}")

    if _model is None:
        if _state == "idle":
            threading.Thread(target=_warmup, name="faster-whisper-warmup", daemon=True).start()
        raise HTTPException(
            status_code=503,
            detail=f"faster-whisper model is not ready yet ({_state}: {_state_detail}). Retry once /health reports state=ready.",
            headers={"Retry-After": "5"},
        )

    language = (request.query_params.get("language") or _default_language() or "fr").lower()
    try:
        beam_size = int(request.query_params.get("beam_size", "5"))
    except ValueError:
        beam_size = 5

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty request body; expected WAV audio bytes.")

    # Hand the raw WAV bytes to faster-whisper's own decoder (PyAV): it decodes
    # AND resamples to the model's 16kHz mono, regardless of the input sample rate
    # or channel count. Passing a decoded ndarray would assume it is already 16kHz
    # and silently mistranscribe anything else.
    started = time.perf_counter()
    try:
        with _infer_lock:
            segments, info = _model.transcribe(
                io.BytesIO(body),
                language=language,
                beam_size=beam_size,
                vad_filter=True,  # trims leading/trailing silence; robust to endpointing slack
            )
            text = "".join(segment.text for segment in segments).strip()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return {
        "text": text,
        "language": getattr(info, "language", language),
        "language_probability": getattr(info, "language_probability", None),
        "duration": getattr(info, "duration", None),
        "elapsed_ms": elapsed_ms,
    }
