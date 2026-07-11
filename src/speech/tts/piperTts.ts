import * as fs from "fs";
import * as path from "path";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { AudioBuffer, AudioFormat } from "../../audio/types";
import { encodePcm16Wav } from "../../audio/wav";
import { VoiceLanguage } from "../../types";
import { AsyncEventQueue } from "./asyncEventQueue";
import { ITTSProvider } from "./ITTSProvider";
import { PiperTTSOptions, TTSAudioResult, TTSEvent, TTSSynthesisOptions, TTSSetupCheck } from "./types";

type SpawnFunction = typeof spawn;

interface PiperInternals {
  spawn?: SpawnFunction;
  now?: () => number;
  existsSync?: typeof fs.existsSync;
  readFileSync?: typeof fs.readFileSync;
}

/**
 * espeak-ng (Piper's phonemizer) reads markdown markup characters out loud
 * (e.g. "*" becomes "astérisque" in French), so they must be removed before synthesis.
 */
export function stripPronouncedMarkup(text: string): string {
  return text
    .replace(/[*`]/g, " ")
    .replace(/(^|\s)#+(?=\s)/g, "$1")
    .replace(/_+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Piper is intentionally run as a separate CLI process to preserve its GPL boundary. */
export class PiperTTSProvider implements ITTSProvider {
  readonly name = "piper";
  private readonly binaryPath: string;
  private readonly voice: string;
  private readonly speaker?: number;
  private readonly language: VoiceLanguage;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFunction;
  private readonly now: () => number;
  private readonly existsSync: typeof fs.existsSync;
  private readonly readFileSync: typeof fs.readFileSync;
  private readonly sampleRates = new Map<string, number>();

  constructor(options: PiperTTSOptions, internals: PiperInternals = {}) {
    this.binaryPath = path.resolve(options.binaryPath);
    this.voice = path.resolve(options.voice);
    this.speaker = options.speaker;
    this.language = options.language;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.spawnFn = internals.spawn || spawn;
    this.now = internals.now || Date.now;
    this.existsSync = internals.existsSync || fs.existsSync;
    this.readFileSync = internals.readFileSync || fs.readFileSync;
  }

  async checkSetup(): Promise<TTSSetupCheck> {
    if (!this.existsSync(this.binaryPath)) return { ok: false, details: `Piper binary not found: ${this.binaryPath}` };
    if (!this.existsSync(this.voice)) return { ok: false, details: `Piper voice model not found: ${this.voice}` };
    if (!this.existsSync(`${this.voice}.json`)) return { ok: false, details: `Piper voice config not found: ${this.voice}.json` };
    try {
      const result = await this.synthesize("Bonjour", { language: this.language });
      return { ok: true, details: `Piper ready (${path.basename(this.voice)}), warm-up ${result.latencyMs} ms.` };
    } catch (error) {
      return { ok: false, details: `Piper validation failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async synthesize(text: string, options: TTSSynthesisOptions = {}): Promise<TTSAudioResult> {
    const trimmed = stripPronouncedMarkup(text);
    if (!trimmed) throw new Error("Cannot synthesize empty text.");
    if (options.signal?.aborted) throw new Error("Piper synthesis was cancelled.");
    const voice = path.resolve(options.voice || this.voice);
    const speaker = options.speaker ?? this.speaker;
    // Raw PCM output only: the piper.exe Windows build (rhasspy 2023.11.14-2) leaves
    // stdout in text mode for `--output_file -`, which corrupts WAV bytes with CRLF
    // translation. Binary mode is only set for --output-raw.
    const format = this.voiceFormat(voice);
    const args = ["--model", voice, "--output-raw"];
    if (speaker !== undefined) args.push("--speaker", String(speaker));
    const startedAt = this.now();
    const pcm = await this.run(args, trimmed, options.signal);
    const wav = encodePcm16Wav(pcm, format);
    const audio: AudioBuffer = { data: wav, format, container: "wav" };
    return { audio, latencyMs: this.now() - startedAt, bytes: wav.length, contentType: "audio/wav" };
  }

  private voiceFormat(voice: string): AudioFormat {
    let sampleRate = this.sampleRates.get(voice);
    if (sampleRate === undefined) {
      const configPath = `${voice}.json`;
      let parsed: { audio?: { sample_rate?: number } };
      try {
        parsed = JSON.parse(this.readFileSync(configPath, "utf8")) as { audio?: { sample_rate?: number } };
      } catch (error) {
        throw new Error(`Cannot read Piper voice config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      sampleRate = parsed.audio?.sample_rate;
      if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate <= 0) {
        throw new Error(`Piper voice config ${configPath} has no valid audio.sample_rate.`);
      }
      this.sampleRates.set(voice, sampleRate);
    }
    return { sampleRate, channels: 1, bitDepth: 16, encoding: "pcm_s16le" };
  }

  synthesizeChunks(chunks: AsyncIterable<string> | Iterable<string>, options: TTSSynthesisOptions = {}): AsyncIterable<TTSEvent> {
    const queue = new AsyncEventQueue<TTSEvent>();
    const startedAt = this.now();
    void (async () => {
      let chunkIndex = 0;
      try {
        for await (const raw of chunks) {
          if (options.signal?.aborted) throw new Error("Piper synthesis was cancelled.");
          const text = stripPronouncedMarkup(raw);
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

  private run(args: string[], text: string, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = this.spawnFn(this.binaryPath, args, { stdio: "pipe", windowsHide: true }); }
      catch (error) { reject(error); return; }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (error?: Error, data?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(data || Buffer.alloc(0));
      };
      const abort = () => { child.kill(); finish(new Error("Piper synthesis was cancelled.")); };
      const timeout = setTimeout(() => { child.kill(); finish(new Error(`Piper synthesis timed out after ${this.timeoutMs} ms.`)); }, this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (signal?.aborted) return finish(new Error("Piper synthesis was cancelled."));
        const output = Buffer.concat(stdout);
        if (code !== 0) return finish(new Error(`Piper exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        if (output.length === 0) return finish(new Error(`Piper produced no audio. ${Buffer.concat(stderr).toString("utf8").trim()}`));
        if (output.length % 2 !== 0) return finish(new Error(`Piper produced a malformed PCM stream (odd byte count ${output.length}).`));
        finish(undefined, output);
      });
      child.stdin.end(`${text}\n`, "utf8");
    });
  }
}
