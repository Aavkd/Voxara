import { AudioBuffer, AudioFormat } from "../../audio/types";
import { decodePcm16Wav, PCM16_MONO_16KHZ } from "../../audio/wav";
import { VoiceLanguage } from "../../types";
import { ITTSProvider } from "./ITTSProvider";
import { AsyncEventQueue } from "./asyncEventQueue";
import {
  Qwen3TTSOptions,
  TTSAudioResult,
  TTSEvent,
  TTSSynthesisOptions,
  TTSSetupCheck,
} from "./types";

type FetchFunction = typeof fetch;

interface Qwen3TTSInternals {
  fetch?: FetchFunction;
  now?: () => number;
}

export class Qwen3TTSProvider implements ITTSProvider {
  readonly name = "qwen3-tts";

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly language: VoiceLanguage;
  private readonly sampleRate: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFunction;
  private readonly now: () => number;

  constructor(options: Qwen3TTSOptions, internals: Qwen3TTSInternals = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.model = options.model;
    this.language = options.language;
    this.sampleRate = options.sampleRate;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.fetchFn = internals.fetch || fetch;
    this.now = internals.now || Date.now;
  }

  async checkSetup(): Promise<TTSSetupCheck> {
    try {
      const health = await this.fetchWithTimeout(urlJoin(this.baseUrl, "/health"), {
        method: "GET",
      }, 5000);

      if (health.ok) {
        const status = await readHealthStatus(health);
        const langLabel = mapQwenTTSLanguage(this.language);

        // The service answers /health as soon as it binds the port, but the
        // model may still be downloading/loading. Distinguish those states so a
        // "backend OK" line is not immediately followed by a synthesis timeout.
        if (status && status.state && status.state !== "ready") {
          if (status.state === "error") {
            return {
              ok: false,
              details: `Qwen3-TTS model failed to load: ${status.detail || "unknown error"}.`,
            };
          }
          return {
            ok: false,
            warning: true,
            details: `${this.baseUrl} reachable, but the model is not ready yet (${status.state}${status.detail ? `: ${status.detail}` : ""}). Wait for the weights to finish downloading, then re-run.`,
          };
        }

        return {
          ok: true,
          details: `${this.baseUrl}, model: ${this.model}, language: ${langLabel}`,
        };
      }

      if (health.status !== 404) {
        return {
          ok: false,
          details: `Qwen3-TTS health check failed (${health.status} ${health.statusText}).`,
        };
      }

      const root = await this.fetchWithTimeout(this.baseUrl, { method: "GET" }, 5000);
      if (root.ok) {
        return {
          ok: true,
          details: `${this.baseUrl} is reachable; /health is not exposed by this service.`,
        };
      }

      return {
        ok: false,
        details: `Qwen3-TTS service is reachable but returned ${root.status} ${root.statusText}.`,
      };
    } catch (err) {
      return {
        ok: false,
        details: `Qwen3-TTS service is not available at ${this.baseUrl}. ${formatFetchError(err)}`,
      };
    }
  }

  async synthesize(text: string, options: TTSSynthesisOptions = {}): Promise<TTSAudioResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot synthesize empty text.");
    }

    const startedAt = this.now();
    const language = mapQwenTTSLanguage(options.language || this.language);
    const body = {
      model: this.model,
      input: trimmed,
      text: trimmed,
      language,
      // vLLM-Omni's /v1/audio/speech dispatches on task_type; the local Python
      // wrapper ignores unknown fields, so this is safe for both backends.
      // No `voice` field: that selects a CustomVoice speaker preset and is
      // invalid for VoiceDesign, where the voice comes from `instructions`.
      task_type: "VoiceDesign",
      instructions: options.voiceDesignPrompt || "",
      instruct: options.voiceDesignPrompt || "",
      response_format: "wav",
      format: "wav",
    };

    const requestInit: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/wav,application/json",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    };

    const response = await this.postSpeechRequest(requestInit);
    if (!response.ok) {
      throw new Error(await formatTTSResponseError(response));
    }

    const audio = await parseAudioResponse(response, this.sampleRate);
    return {
      audio,
      latencyMs: this.now() - startedAt,
      bytes: audio.data.length,
      contentType: response.headers.get("content-type") || undefined,
    };
  }

  synthesizeChunks(
    chunks: AsyncIterable<string> | Iterable<string>,
    options: TTSSynthesisOptions = {}
  ): AsyncIterable<TTSEvent> {
    const queue = new AsyncEventQueue<TTSEvent>();
    const startedAt = this.now();

    const pushError = (error: Error, raw?: string) => {
      queue.push({
        type: "error",
        error,
        timestampMs: this.now() - startedAt,
        raw,
      });
    };

    const run = async () => {
      let chunkIndex = 0;

      try {
        for await (const chunk of toAsyncIterable(chunks)) {
          if (options.signal?.aborted) {
            throw new Error("Qwen3-TTS synthesis was cancelled.");
          }

          const trimmed = chunk.trim();
          if (!trimmed) {
            continue;
          }

          const result = await this.synthesize(trimmed, options);
          queue.push({
            type: "audio",
            audio: result.audio,
            text: trimmed,
            chunkIndex,
            timestampMs: this.now() - startedAt,
            latencyMs: result.latencyMs,
          });
          chunkIndex += 1;
        }
      } catch (err) {
        pushError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        queue.push({ type: "end", timestampMs: this.now() - startedAt });
        queue.close();
      }
    };

    void run();
    return queue;
  }

  private async postSpeechRequest(requestInit: RequestInit): Promise<Response> {
    const primary = await this.fetchWithTimeout(urlJoin(this.baseUrl, "/v1/audio/speech"), requestInit, this.timeoutMs);
    if (primary.status !== 404) {
      return primary;
    }

    return this.fetchWithTimeout(urlJoin(this.baseUrl, "/synthesize"), requestInit, this.timeoutMs);
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const callerSignal = init.signal;
    const abortFromCaller = () => timeoutController.abort();

    if (callerSignal) {
      if (callerSignal.aborted) {
        throw new Error("Qwen3-TTS synthesis was cancelled.");
      }
      callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      return await this.fetchFn(url, {
        ...init,
        signal: timeoutController.signal,
      });
    } catch (err) {
      if (callerSignal?.aborted) {
        throw new Error("Qwen3-TTS synthesis was cancelled.");
      }
      if (timeoutController.signal.aborted) {
        throw new Error(`Qwen3-TTS request timed out after ${timeoutMs} ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export function mapQwenTTSLanguage(language: VoiceLanguage): "French" | "English" {
  if (language === "fr") {
    return "French";
  }
  if (language === "en") {
    return "English";
  }
  throw new Error(`Unsupported voice language "${language}". Supported values: fr, en.`);
}

interface Qwen3HealthStatus {
  state?: string;
  ready?: boolean;
  detail?: string;
}

async function readHealthStatus(response: Response): Promise<Qwen3HealthStatus | undefined> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }
  try {
    const json = (await response.json()) as Record<string, unknown>;
    return {
      state: typeof json.state === "string" ? json.state : undefined,
      ready: typeof json.ready === "boolean" ? json.ready : undefined,
      detail: typeof json.detail === "string" ? json.detail : undefined,
    };
  } catch {
    return undefined;
  }
}

async function parseAudioResponse(response: Response, sampleRate: number): Promise<AudioBuffer> {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const json = await response.json() as Record<string, unknown>;
    return audioBufferFromJson(json, sampleRate);
  }

  const data = Buffer.from(await response.arrayBuffer());
  return audioBufferFromBytes(data, sampleRate);
}

function audioBufferFromJson(json: Record<string, unknown>, sampleRate: number): AudioBuffer {
  const audioValue =
    json.audio_base64 ||
    json.audioBase64 ||
    json.audio ||
    pickNestedAudio(json);

  if (typeof audioValue !== "string" || audioValue.length === 0) {
    throw new Error("Qwen3-TTS JSON response did not include audio_base64/audioBase64/audio.");
  }

  const encoded = audioValue.includes(",") ? audioValue.split(",").pop() || "" : audioValue;
  const data = Buffer.from(encoded, "base64");
  const responseSampleRate = typeof json.sample_rate === "number"
    ? json.sample_rate
    : typeof json.sampleRate === "number"
      ? json.sampleRate
      : sampleRate;

  return audioBufferFromBytes(data, responseSampleRate);
}

function pickNestedAudio(json: Record<string, unknown>): unknown {
  const data = json.data;
  if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== "object" || data[0] === null) {
    return undefined;
  }

  const first = data[0] as Record<string, unknown>;
  return first.audio_base64 || first.audioBase64 || first.audio;
}

function audioBufferFromBytes(data: Buffer, sampleRate: number): AudioBuffer {
  if (isWav(data)) {
    const decoded = decodePcm16Wav(data);
    return {
      data,
      format: decoded.format,
      container: "wav",
    };
  }

  return {
    data,
    format: pcmFormat(sampleRate),
    container: "pcm",
  };
}

function pcmFormat(sampleRate: number): AudioFormat {
  return {
    ...PCM16_MONO_16KHZ,
    sampleRate,
  };
}

function isWav(data: Buffer): boolean {
  return data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WAVE";
}

async function formatTTSResponseError(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }

  // FastAPI reports errors as {"detail": "..."}; surface that directly.
  let detail = body;
  if (body && (response.headers.get("content-type") || "").includes("application/json")) {
    try {
      const json = JSON.parse(body) as { detail?: unknown };
      if (typeof json.detail === "string" && json.detail.length > 0) {
        detail = json.detail;
      }
    } catch {
      // keep raw body
    }
  }

  if (response.status === 503) {
    return `Qwen3-TTS is not ready yet: ${detail || "model is still loading"}.`;
  }

  const suffix = detail ? ` ${detail.slice(0, 500)}` : "";
  return `Qwen3-TTS synthesis failed (${response.status} ${response.statusText}).${suffix}`;
}

function formatFetchError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function urlJoin(baseUrl: string, pathname: string): string {
  return `${baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

async function* toAsyncIterable<T>(values: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> {
  for await (const value of values) {
    yield value;
  }
}
