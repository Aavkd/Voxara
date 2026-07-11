import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { encodePcm16Wav } from "../../audio/wav";
import { VoiceLanguage } from "../../types";
import { ISTTProvider } from "./ISTTProvider";
import {
  STTAudioInput,
  STTSetupCheck,
  STTTranscriptionOptions,
  TranscriptEvent,
  WhisperCppOptions,
} from "./types";

type SpawnFunction = typeof spawn;

interface WhisperCppProviderInternals {
  spawn?: SpawnFunction;
  fs?: Pick<typeof fs, "existsSync" | "writeFileSync" | "rmSync">;
  tmpDir?: string;
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

export class WhisperCppSTTProvider implements ISTTProvider {
  readonly name = "whisper-cpp";

  private readonly binaryPath: string;
  private readonly modelPath: string;
  private readonly language: VoiceLanguage;
  private readonly sampleRate: number;
  private readonly spawnFn: SpawnFunction;
  private readonly fsApi: Pick<typeof fs, "existsSync" | "writeFileSync" | "rmSync">;
  private readonly tmpDir: string;

  constructor(options: WhisperCppOptions, internals: WhisperCppProviderInternals = {}) {
    this.binaryPath = options.binaryPath;
    this.modelPath = options.modelPath;
    this.language = options.language;
    this.sampleRate = options.sampleRate;
    this.spawnFn = internals.spawn || spawn;
    this.fsApi = internals.fs || fs;
    this.tmpDir = internals.tmpDir || os.tmpdir();
  }

  async checkSetup(): Promise<STTSetupCheck> {
    const modelCheck = checkModelFile(this.fsApi, this.modelPath);
    if (!modelCheck.ok) {
      return modelCheck;
    }

    const binaryCheck = await checkBinary(this.spawnFn, this.fsApi, this.binaryPath);
    if (!binaryCheck.ok) {
      return binaryCheck;
    }

    return {
      ok: true,
      details: `${this.binaryPath}, model: ${this.modelPath}, language: ${mapWhisperLanguage(this.language)}`,
    };
  }

  transcribe(audio: STTAudioInput, options: STTTranscriptionOptions = {}): AsyncIterable<TranscriptEvent> {
    const queue = new AsyncEventQueue<TranscriptEvent>();
    const startedAt = Date.now();
    const language = mapWhisperLanguage(options.language || this.language);
    const inputPath = path.join(this.tmpDir, `llmtest-stt-${process.pid}-${Date.now()}.wav`);
    let child: ChildProcessWithoutNullStreams | undefined;
    let settled = false;

    const pushError = (error: Error, raw?: string) => {
      queue.push({
        type: "error",
        error,
        timestampMs: Date.now() - startedAt,
        raw,
      });
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      queue.push({ type: "end", timestampMs: Date.now() - startedAt });
      queue.close();
      this.fsApi.rmSync(inputPath, { force: true });
    };

    setImmediate(() => {
      const setup = checkModelFile(this.fsApi, this.modelPath);
      if (!setup.ok) {
        pushError(new Error(setup.details));
        finish();
        return;
      }

      try {
        const wav = audio.container === "wav" ? audio.data : encodePcm16Wav(audio.data, audio.format);
        this.fsApi.writeFileSync(inputPath, wav);
      } catch (err) {
        pushError(new Error(`Could not prepare audio for whisper.cpp: ${err instanceof Error ? err.message : String(err)}`));
        finish();
        return;
      }

      const args = [
        "-m",
        this.modelPath,
        "-f",
        inputPath,
        "-l",
        language,
        "-nt",
      ];

      try {
        child = this.spawnFn(this.binaryPath, args);
      } catch (err) {
        pushError(new Error(formatBinaryError(this.binaryPath, err)));
        finish();
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let lastPartial = "";

      const handleChunk = (chunk: Buffer) => {
        const text = parseWhisperTranscript(chunk.toString("utf8"));
        if (text && text !== lastPartial) {
          lastPartial = text;
          queue.push({
            type: "partial",
            text,
            timestampMs: Date.now() - startedAt,
            raw: chunk.toString("utf8"),
          });
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        handleChunk(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      const abort = () => {
        if (child && !child.killed) {
          child.kill();
        }
      };
      options.signal?.addEventListener("abort", abort, { once: true });

      child.once("error", (err) => {
        options.signal?.removeEventListener("abort", abort);
        pushError(new Error(formatBinaryError(this.binaryPath, err)));
        finish();
      });

      child.once("close", (code) => {
        options.signal?.removeEventListener("abort", abort);
        const rawStdout = Buffer.concat(stdout).toString("utf8");
        const rawStderr = Buffer.concat(stderr).toString("utf8");
        const raw = `${rawStdout}\n${rawStderr}`.trim();

        if (options.signal?.aborted) {
          pushError(new Error("whisper.cpp transcription was cancelled."), raw);
          finish();
          return;
        }

        if (code !== 0) {
          pushError(new Error(formatProcessExitError(code, raw)), raw);
          finish();
          return;
        }

        const finalText = parseWhisperTranscript(rawStdout) || parseWhisperTranscript(rawStderr);
        if (finalText) {
          queue.push({
            type: "final",
            text: finalText,
            timestampMs: Date.now() - startedAt,
            raw,
          });
        }

        finish();
      });
    });

    return queue;
  }
}

export function mapWhisperLanguage(language: VoiceLanguage): "fr" | "en" {
  if (language === "fr" || language === "en") {
    return language;
  }
  throw new Error(`Unsupported voice language "${language}". Supported values: fr, en.`);
}

export function parseWhisperTranscript(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => cleanTranscriptLine(line))
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTranscriptLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  if (/^(whisper_|system_info:|main:|ggml_|whisper_init|error:)/i.test(trimmed)) {
    return "";
  }

  if (/^\[[0-9:.]+\s+-->\s+[0-9:.]+\]\s*/.test(trimmed)) {
    return trimmed.replace(/^\[[0-9:.]+\s+-->\s+[0-9:.]+\]\s*/, "").trim();
  }

  if (/^\[[0-9:.]+\]\s*/.test(trimmed)) {
    return trimmed.replace(/^\[[0-9:.]+\]\s*/, "").trim();
  }

  if (/^\s*\w+:\s+\d+%/.test(trimmed)) {
    return "";
  }

  return trimmed;
}

function checkModelFile(
  fsApi: Pick<typeof fs, "existsSync">,
  modelPath: string
): STTSetupCheck {
  if (!modelPath || !fsApi.existsSync(modelPath)) {
    return {
      ok: false,
      details: `Whisper model not found at "${modelPath}". Set VOICE_STT_MODEL_PATH to a local whisper.cpp model file.`,
    };
  }

  return {
    ok: true,
    details: `Model found at ${modelPath}`,
  };
}

function checkBinary(
  spawnFn: SpawnFunction,
  fsApi: Pick<typeof fs, "existsSync">,
  binaryPath: string
): Promise<STTSetupCheck> {
  if (isPathLike(binaryPath) && !fsApi.existsSync(binaryPath)) {
    return Promise.resolve({
      ok: false,
      details: `Whisper binary not found at "${binaryPath}". Set VOICE_STT_BINARY_PATH to whisper.cpp's whisper-cli executable.`,
    });
  }

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;

    try {
      child = spawnFn(binaryPath, ["-h"]);
    } catch (err) {
      resolve({
        ok: false,
        details: formatBinaryError(binaryPath, err),
      });
      return;
    }

    child.once("error", (err) => {
      resolve({
        ok: false,
        details: formatBinaryError(binaryPath, err),
      });
    });

    child.stdout.resume();
    child.stderr.resume();

    child.once("close", () => {
      resolve({
        ok: true,
        details: `Whisper binary found: ${binaryPath}`,
      });
    });
  });
}

function isPathLike(binaryPath: string): boolean {
  return path.isAbsolute(binaryPath) || binaryPath.includes("/") || binaryPath.includes("\\");
}

function formatBinaryError(binaryPath: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Whisper binary "${binaryPath}" is not available. Set VOICE_STT_BINARY_PATH to whisper.cpp's whisper-cli executable. ${detail}`;
}

function formatProcessExitError(code: number | null, raw: string): string {
  const suffix = raw ? ` Output: ${raw}` : "";
  return `whisper.cpp exited with code ${code ?? "unknown"}.${suffix}`;
}
