import { encodePcm16Wav } from "../../audio/wav";
import { VoiceLanguage } from "../../types";
import { ISTTProvider } from "./ISTTProvider";
import {
  FasterWhisperOptions,
  STTAudioInput,
  STTSetupCheck,
  STTTranscriptionOptions,
  TranscriptEvent,
} from "./types";

type FetchFunction = typeof fetch;

interface FasterWhisperInternals {
  fetch?: FetchFunction;
  now?: () => number;
}

interface QueuedEvent<T> {
  value?: T;
  done?: boolean;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly events: QueuedEvent<T>[] = [];
  private readonly waiters: Array<(event: QueuedEvent<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value });
      return;
    }
    this.events.push({ value });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: true });
    } else {
      this.events.push({ done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const event = this.events.shift() || await new Promise<QueuedEvent<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (event.done) {
        return;
      }
      if (event.value !== undefined) {
        yield event.value;
      }
    }
  }
}

/**
 * STT provider backed by the local faster-whisper HTTP sidecar
 * (tools/faster-whisper/server.py). The model is loaded once on the server, so
 * each utterance is a single fast POST instead of shelling out to whisper.cpp
 * and reloading the model every call.
 */
export class FasterWhisperHttpSTTProvider implements ISTTProvider {
  readonly name = "faster-whisper";

  private readonly baseUrl: string;
  private readonly language: VoiceLanguage;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFunction;
  private readonly now: () => number;

  constructor(options: FasterWhisperOptions, internals: FasterWhisperInternals = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.language = options.language;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.fetchFn = internals.fetch || fetch;
    this.now = internals.now || Date.now;
  }

  async checkSetup(): Promise<STTSetupCheck> {
    try {
      const health = await this.fetchWithTimeout(urlJoin(this.baseUrl, "/health"), { method: "GET" }, 5000);

      if (!health.ok) {
        return {
          ok: false,
          details: `faster-whisper health check failed (${health.status} ${health.statusText}).`,
        };
      }

      const status = await readHealthStatus(health);
      if (status && status.state && status.state !== "ready") {
        if (status.state === "error") {
          return { ok: false, details: `faster-whisper model failed to load: ${status.detail || "unknown error"}.` };
        }
        return {
          ok: false,
          warning: true,
          details: `${this.baseUrl} reachable, but the model is not ready yet (${status.state}${status.detail ? `: ${status.detail}` : ""}). Wait for it to finish loading, then re-run.`,
        };
      }

      const label = status?.loadedWith || status?.model || "faster-whisper";
      return {
        ok: true,
        details: `${this.baseUrl}, model: ${label}, language: ${mapWhisperLanguage(this.language)}`,
      };
    } catch (err) {
      return {
        ok: false,
        details: `faster-whisper service is not available at ${this.baseUrl}. ${formatFetchError(err)} Start it with: npm run stt:start`,
      };
    }
  }

  transcribe(audio: STTAudioInput, options: STTTranscriptionOptions = {}): AsyncIterable<TranscriptEvent> {
    const queue = new AsyncEventQueue<TranscriptEvent>();
    const startedAt = this.now();
    const language = mapWhisperLanguage(options.language || this.language);

    const run = async () => {
      try {
        const wav = audio.container === "wav" ? audio.data : encodePcm16Wav(audio.data, audio.format);
        // Send the raw bytes. A Node Buffer/Uint8Array is a valid fetch body at
        // runtime but the DOM lib's BodyInit type doesn't list typed arrays, so
        // cast to the exact expected body type.
        const bytes = new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength);
        const url = `${urlJoin(this.baseUrl, "/transcribe")}?language=${encodeURIComponent(language)}`;
        const response = await this.fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "audio/wav", Accept: "application/json" },
            body: bytes as unknown as RequestInit["body"],
            signal: options.signal,
          },
          this.timeoutMs
        );

        if (!response.ok) {
          throw new Error(await formatResponseError(response));
        }

        const json = (await response.json()) as { text?: unknown };
        const text = typeof json.text === "string" ? json.text.trim() : "";
        if (text) {
          queue.push({ type: "final", text, timestampMs: this.now() - startedAt });
        }
      } catch (err) {
        queue.push({
          type: "error",
          error: err instanceof Error ? err : new Error(String(err)),
          timestampMs: this.now() - startedAt,
        });
      } finally {
        queue.push({ type: "end", timestampMs: this.now() - startedAt });
        queue.close();
      }
    };

    void run();
    return queue;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const callerSignal = init.signal;
    const abortFromCaller = () => timeoutController.abort();

    if (callerSignal) {
      if (callerSignal.aborted) {
        throw new Error("faster-whisper transcription was cancelled.");
      }
      callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      return await this.fetchFn(url, { ...init, signal: timeoutController.signal });
    } catch (err) {
      if (callerSignal?.aborted) {
        throw new Error("faster-whisper transcription was cancelled.");
      }
      if (timeoutController.signal.aborted) {
        throw new Error(`faster-whisper request timed out after ${timeoutMs} ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export function mapWhisperLanguage(language: VoiceLanguage): "fr" | "en" {
  if (language === "fr" || language === "en") {
    return language;
  }
  throw new Error(`Unsupported voice language "${language}". Supported values: fr, en.`);
}

interface WhisperHealthStatus {
  state?: string;
  ready?: boolean;
  detail?: string;
  model?: string;
  loadedWith?: string;
}

async function readHealthStatus(response: Response): Promise<WhisperHealthStatus | undefined> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }
  try {
    const json = (await response.json()) as Record<string, unknown>;
    const loaded = Array.isArray(json.loaded_with) ? json.loaded_with.join(" / ") : undefined;
    return {
      state: typeof json.state === "string" ? json.state : undefined,
      ready: typeof json.ready === "boolean" ? json.ready : undefined,
      detail: typeof json.detail === "string" ? json.detail : undefined,
      model: typeof json.model === "string" ? json.model : undefined,
      loadedWith: loaded,
    };
  } catch {
    return undefined;
  }
}

async function formatResponseError(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }

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
    return `faster-whisper is not ready yet: ${detail || "model is still loading"}.`;
  }

  const suffix = detail ? ` ${detail.slice(0, 500)}` : "";
  return `faster-whisper transcription failed (${response.status} ${response.statusText}).${suffix}`;
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
