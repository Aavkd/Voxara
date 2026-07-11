import io
import os
import threading
import traceback
from typing import Optional

import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from qwen_tts import Qwen3TTSModel


DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"


class SpeechRequest(BaseModel):
    input: Optional[str] = None
    text: Optional[str] = None
    language: str = "French"
    instructions: Optional[str] = None
    instruct: Optional[str] = None
    model: Optional[str] = None


def _torch_dtype():
    dtype_name = os.environ.get(
        "QWEN3_TTS_DTYPE",
        "bfloat16" if torch.cuda.is_available() else "float32",
    ).lower()
    return {
        "float16": torch.float16,
        "fp16": torch.float16,
        "bfloat16": torch.bfloat16,
        "bf16": torch.bfloat16,
        "float32": torch.float32,
        "fp32": torch.float32,
    }.get(dtype_name, torch.bfloat16 if torch.cuda.is_available() else torch.float32)


# ---------------------------------------------------------------------------
# Model lifecycle
#
# The first load downloads several GB of weights and can take minutes. Doing
# that lazily inside the first /synthesize request means the HTTP client times
# out long before generation can start, and concurrent requests each kick off
# their own load (the model ends up loaded more than once). To avoid both, the
# model is loaded exactly once, behind a lock, and preferably warmed up at
# startup so /health can report real readiness.
# ---------------------------------------------------------------------------

_model: Optional[Qwen3TTSModel] = None
_load_lock = threading.Lock()      # single-flight guard around from_pretrained
_generate_lock = threading.Lock()  # serialize generation (CUDA / model is not re-entrant)
_state = "idle"                    # idle | loading | ready | error
_state_detail = ""


def _model_target() -> str:
    return os.environ.get("VOICE_TTS_MODEL", DEFAULT_MODEL)


def _device() -> str:
    return os.environ.get("QWEN3_TTS_DEVICE", "cuda:0" if torch.cuda.is_available() else "cpu")


def _load_model() -> Qwen3TTSModel:
    """Load the model once. Safe to call from multiple threads."""
    global _model, _state, _state_detail

    if _model is not None:
        return _model

    with _load_lock:
        if _model is not None:
            return _model

        model_name = _model_target()
        device = _device()
        kwargs = {
            "device_map": device,
            "dtype": _torch_dtype(),
        }
        attn = os.environ.get("QWEN3_TTS_ATTN")
        if attn:
            kwargs["attn_implementation"] = attn

        _state = "loading"
        _state_detail = f"loading {model_name} on {device} (first run downloads weights)"
        print(f"[qwen3-tts] loading {model_name} on {device}", flush=True)
        try:
            model = Qwen3TTSModel.from_pretrained(model_name, **kwargs)
        except Exception as exc:  # noqa: BLE001 - surfaced via /health and logs
            _state = "error"
            _state_detail = str(exc)
            print(f"[qwen3-tts] model load failed: {exc}", flush=True)
            traceback.print_exc()
            raise

        _model = model
        _state = "ready"
        _state_detail = f"{model_name} on {device}"
        print(f"[qwen3-tts] model ready ({_state_detail})", flush=True)
        return _model


def _warmup() -> None:
    try:
        _load_model()
    except Exception:
        # Already logged in _load_model; keep the server up so /health can report the error.
        pass


app = FastAPI(title="Local Qwen3-TTS wrapper for llmtest")


@app.on_event("startup")
def _on_startup() -> None:
    if os.environ.get("QWEN3_TTS_WARMUP", "1").lower() not in ("0", "false", "no"):
        # Load in the background so the HTTP server starts accepting connections
        # immediately; /health reports state="loading" until the weights are ready.
        threading.Thread(target=_warmup, name="qwen3-tts-warmup", daemon=True).start()


@app.get("/health")
def health():
    return {
        "ok": _state != "error",
        "ready": _state == "ready",
        "state": _state,
        "detail": _state_detail,
        "model": _model_target(),
        "device": _device(),
        "cuda": torch.cuda.is_available(),
    }


@app.post("/v1/audio/speech")
def openai_compatible_speech(request: SpeechRequest):
    return synthesize(request)


@app.post("/synthesize")
def synthesize(request: SpeechRequest):
    text = (request.input or request.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Missing input/text.")

    if _state == "error":
        raise HTTPException(status_code=500, detail=f"Qwen3-TTS model failed to load: {_state_detail}")

    if _model is None:
        # Kick off the (single-flight) load if warmup was disabled, but do not
        # block the request thread for minutes — tell the caller to retry.
        if _state == "idle":
            threading.Thread(target=_warmup, name="qwen3-tts-warmup", daemon=True).start()
        raise HTTPException(
            status_code=503,
            detail=f"Qwen3-TTS model is not ready yet ({_state}: {_state_detail}). Retry once /health reports state=ready.",
            headers={"Retry-After": "10"},
        )

    try:
        with _generate_lock:
            wavs, sample_rate = _model.generate_voice_design(
                text=text,
                language=request.language,
                instruct=request.instructions or request.instruct or "",
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    wav_io = io.BytesIO()
    sf.write(wav_io, wavs[0], sample_rate, format="WAV")
    return Response(content=wav_io.getvalue(), media_type="audio/wav")
