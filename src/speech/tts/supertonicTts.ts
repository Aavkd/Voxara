import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { AudioBuffer } from "../../audio/types";
import { encodePcm16Wav } from "../../audio/wav";
import { VoiceLanguage } from "../../types";
import { AsyncEventQueue } from "./asyncEventQueue";
import { ITTSProvider } from "./ITTSProvider";
import { SupertonicTTSOptions, TTSAudioResult, TTSEvent, TTSSynthesisOptions, TTSSetupCheck } from "./types";

interface SupertonicEngine {
  sampleRate: number;
  call(text: string, language: string, style: unknown, totalSteps: number, speed: number): Promise<{ wav: number[] | Float32Array }>;
}

interface SupertonicSdk {
  loadTextToSpeech(onnxDir: string, useGpu?: boolean): Promise<SupertonicEngine>;
  loadVoiceStyle(stylePaths: string[], verbose?: boolean): unknown;
}

interface SupertonicInternals {
  loadSdk?: (helperPath: string) => Promise<SupertonicSdk>;
  now?: () => number;
  existsSync?: typeof fs.existsSync;
}

/** CPU-only in-process ONNX provider using Supertonic's official Node helper. */
export class SupertonicTTSProvider implements ITTSProvider {
  readonly name = "supertonic";
  private readonly assetsDir: string;
  private readonly voice: string;
  private readonly language: VoiceLanguage;
  private readonly timeoutMs: number;
  private readonly totalSteps: number;
  private readonly speed: number;
  private readonly loadSdk: (helperPath: string) => Promise<SupertonicSdk>;
  private readonly now: () => number;
  private readonly existsSync: typeof fs.existsSync;
  private loadPromise?: Promise<void>;
  private engine?: SupertonicEngine;
  private sdk?: SupertonicSdk;
  // Style vectors are immutable per file; reloading them from disk for every
  // chunk added avoidable latency to each synthesized segment.
  private readonly styleCache = new Map<string, unknown>();

  constructor(options: SupertonicTTSOptions, internals: SupertonicInternals = {}) {
    this.assetsDir = path.resolve(options.assetsDir);
    this.voice = options.voice;
    this.language = options.language;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.totalSteps = options.totalSteps ?? 8;
    this.speed = options.speed ?? 1.05;
    this.loadSdk = internals.loadSdk || loadOfficialSdk;
    this.now = internals.now || Date.now;
    this.existsSync = internals.existsSync || fs.existsSync;
  }

  async checkSetup(): Promise<TTSSetupCheck> {
    const missing = this.requiredPaths().filter((entry) => !this.existsSync(entry));
    if (missing.length > 0) return { ok: false, details: `Supertonic assets missing: ${missing.join(", ")}` };
    try {
      const result = await this.synthesize("Bonjour", { language: this.language });
      return { ok: true, details: `Supertonic ready (${this.voice}), warm-up ${result.latencyMs} ms (CPU).` };
    } catch (error) {
      return { ok: false, details: `Supertonic validation failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async synthesize(text: string, options: TTSSynthesisOptions = {}): Promise<TTSAudioResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Cannot synthesize empty text.");
    if (options.signal?.aborted) throw new Error("Supertonic synthesis was cancelled.");
    const startedAt = this.now();
    await this.ensureLoaded();
    const stylePath = this.resolveStyle(options.voice || this.voice);
    let style = this.styleCache.get(stylePath);
    if (style === undefined) {
      style = this.sdk!.loadVoiceStyle([stylePath]);
      this.styleCache.set(stylePath, style);
    }
    const inference = this.engine!.call(trimmed, options.language || this.language, style, this.totalSteps, this.speed);
    const result = await raceWithAbortAndTimeout(inference, options.signal, this.timeoutMs);
    const pcm = floatToPcm16(result.wav);
    const audio: AudioBuffer = {
      data: encodePcm16Wav(pcm, { sampleRate: this.engine!.sampleRate, channels: 1, bitDepth: 16, encoding: "pcm_s16le" }),
      format: { sampleRate: this.engine!.sampleRate, channels: 1, bitDepth: 16, encoding: "pcm_s16le" },
      container: "wav",
    };
    return { audio, latencyMs: this.now() - startedAt, bytes: audio.data.length, contentType: "audio/wav" };
  }

  synthesizeChunks(chunks: AsyncIterable<string> | Iterable<string>, options: TTSSynthesisOptions = {}): AsyncIterable<TTSEvent> {
    const queue = new AsyncEventQueue<TTSEvent>();
    const startedAt = this.now();
    void (async () => {
      let chunkIndex = 0;
      try {
        for await (const raw of chunks) {
          if (options.signal?.aborted) throw new Error("Supertonic synthesis was cancelled.");
          const text = raw.trim();
          if (!text) continue;
          const result = await this.synthesize(text, options);
          queue.push({ type: "audio", audio: result.audio, text, chunkIndex, timestampMs: this.now() - startedAt, latencyMs: result.latencyMs });
          chunkIndex += 1;
        }
      } catch (error) {
        queue.push({ type: "error", error: error instanceof Error ? error : new Error(String(error)), timestampMs: this.now() - startedAt });
      } finally {
        queue.push({ type: "end", timestampMs: this.now() - startedAt });
        queue.close();
      }
    })();
    return queue;
  }

  private requiredPaths(): string[] {
    return [
      path.join(this.assetsDir, "onnx", "duration_predictor.onnx"),
      path.join(this.assetsDir, "onnx", "text_encoder.onnx"),
      path.join(this.assetsDir, "onnx", "vector_estimator.onnx"),
      path.join(this.assetsDir, "onnx", "vocoder.onnx"),
      path.join(this.assetsDir, "onnx", "tts.json"),
      path.join(this.assetsDir, "onnx", "unicode_indexer.json"),
      this.resolveStyle(this.voice),
      path.join(this.assetsDir, "nodejs", "helper.mjs"),
    ];
  }

  private resolveStyle(voice: string): string {
    const filename = voice.endsWith(".json") ? voice : `${voice}.json`;
    return path.isAbsolute(filename) ? filename : path.join(this.assetsDir, "voice_styles", filename);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const helperPath = path.join(this.assetsDir, "nodejs", "helper.mjs");
        this.sdk = await this.loadSdk(helperPath);
        // The official helper's false value explicitly selects CPU execution.
        this.engine = await this.sdk.loadTextToSpeech(path.join(this.assetsDir, "onnx"), false);
      })();
    }
    return this.loadPromise;
  }
}

async function loadOfficialSdk(helperPath: string): Promise<SupertonicSdk> {
  // Keep native dynamic import intact when TypeScript targets CommonJS.
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  return dynamicImport(pathToFileURL(helperPath).href) as Promise<SupertonicSdk>;
}

function floatToPcm16(samples: number[] | Float32Array): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm.writeInt16LE(Math.round(sample * 32767), index * 2);
  }
  return pcm;
}

function raceWithAbortAndTimeout<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Supertonic synthesis timed out after ${timeoutMs} ms.`)), timeoutMs);
    const abort = () => finish(new Error("Supertonic synthesis was cancelled."));
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value as T);
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    promise.then((value) => finish(undefined, value), (error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
