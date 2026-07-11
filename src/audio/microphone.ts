import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import {
  AudioDevice,
  AudioRecording,
  MicrophoneCapture,
  RecordAudioOptions,
  RecordUtteranceOptions,
} from "./types";
import { EnergyVad } from "./vad";

export class FfmpegMicrophoneCapture implements MicrophoneCapture {
  async listDevices(): Promise<AudioDevice[]> {
    if (process.platform !== "win32") {
      return [];
    }

    const result = await runCommand("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
    const output = `${result.stdout}\n${result.stderr}`;
    return parseWindowsDshowAudioDevices(output);
  }

  async record(options: RecordAudioOptions): Promise<AudioRecording> {
    if (process.platform !== "win32") {
      throw new Error("Microphone capture currently uses ffmpeg DirectShow on Windows.");
    }

    const durationSeconds = Math.max(0.1, options.durationMs / 1000);
    const outputPath = path.join(os.tmpdir(), `llmtest-mic-${process.pid}-${Date.now()}.wav`);
    const inputName = options.deviceName || "default";

    await runCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "dshow",
      "-i",
      `audio=${inputName}`,
      "-t",
      String(durationSeconds),
      "-ar",
      String(options.sampleRate),
      "-ac",
      "1",
      outputPath,
    ]);

    const data = fs.readFileSync(outputPath);
    if (!options.keepFile) {
      fs.rmSync(outputPath, { force: true });
    }

    return {
      data,
      format: {
        sampleRate: options.sampleRate,
        channels: 1,
        bitDepth: 16,
        encoding: "pcm_s16le",
      },
      container: "wav",
      durationMs: options.durationMs,
      filePath: options.keepFile ? outputPath : undefined,
    };
  }

  async recordUtterance(options: RecordUtteranceOptions): Promise<AudioRecording | undefined> {
    if (process.platform !== "win32") {
      throw new Error("Microphone capture currently uses ffmpeg DirectShow on Windows.");
    }

    const inputName = options.deviceName || "default";
    const frameMs = options.frameMs ?? 20;
    const bytesPerFrame = Math.max(2, Math.round((options.sampleRate * frameMs) / 1000) * 2);
    const vad = new EnergyVad({
      threshold: options.threshold,
      speechStartMs: options.speechStartMs,
      silenceEndMs: options.silenceEndMs,
      sampleRate: options.sampleRate,
      frameMs,
      adaptive: !options.fixedThreshold,
      ...(options.minThreshold !== undefined ? { minThreshold: options.minThreshold } : {}),
      ...(options.noiseToSpeechRatio !== undefined ? { noiseToSpeechRatio: options.noiseToSpeechRatio } : {}),
    });

    // Keep the pre-onset audio in a rolling buffer so the first syllables are
    // not clipped: the VAD only confirms speech after speechStartMs of it.
    const prerollMs = Math.max(options.prerollMs ?? 400, options.speechStartMs + 200);
    const prerollMaxBytes = Math.round((options.sampleRate * prerollMs) / 1000) * 2;

    // Stream raw 16-bit mono PCM to stdout and keep ONE ffmpeg process open for
    // the whole wait. Closing and respawning the stream on silence loses audio
    // during process startup and DirectShow buffering, which silently swallows
    // utterances that start near a window boundary.
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "dshow",
      "-audio_buffer_size", "50",
      "-i", `audio=${inputName}`,
      "-ar", String(options.sampleRate),
      "-ac", "1",
      "-f", "s16le",
      "-",
    ]);

    return new Promise<AudioRecording | undefined>((resolve, reject) => {
      const preroll: Buffer[] = [];
      let prerollBytes = 0;
      const captured: Buffer[] = [];
      let capturedBytes = 0;
      let pending: Buffer = Buffer.alloc(0);
      let sawSpeech = false;
      let elapsedMs = 0;
      let speechStartedAtMs = 0;
      let lastReportAtMs = 0;
      let settled = false;
      const stderr: Buffer[] = [];

      const cleanup = () => {
        options.signal?.removeEventListener("abort", onAbort);
        if (!child.killed) {
          child.kill();
        }
      };

      const finish = (keep: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();

        if (!keep || !sawSpeech) {
          resolve(undefined);
          return;
        }

        const data = Buffer.concat(captured);
        resolve({
          data,
          format: {
            sampleRate: options.sampleRate,
            channels: 1,
            bitDepth: 16,
            encoding: "pcm_s16le",
          },
          container: "pcm",
          durationMs: Math.round((data.length / 2 / options.sampleRate) * 1000),
        });
      };

      const onAbort = () => finish(false);
      if (options.signal) {
        if (options.signal.aborted) {
          cleanup();
          resolve(undefined);
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.once("error", (err) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error(`ffmpeg is not available: ${err.message}`));
      });

      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      child.stdout.on("data", (chunk: Buffer) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

        while (pending.length >= bytesPerFrame) {
          const frame = pending.subarray(0, bytesPerFrame);
          pending = pending.subarray(bytesPerFrame);
          elapsedMs += frameMs;

          if (sawSpeech) {
            captured.push(frame);
            capturedBytes += frame.length;
          } else {
            preroll.push(frame);
            prerollBytes += frame.length;
            while (prerollBytes > prerollMaxBytes && preroll.length > 1) {
              prerollBytes -= preroll[0].length;
              preroll.shift();
            }
          }

          const events = vad.process({
            data: frame,
            format: {
              sampleRate: options.sampleRate,
              channels: 1,
              bitDepth: 16,
              encoding: "pcm_s16le",
            },
            container: "pcm",
          });

          for (const event of events) {
            if (event.type === "speechStart" || event.type === "speechEnd") {
              options.onVadEvent?.(event, vad.levelStats());
            }
            if (event.type === "speechStart" && !sawSpeech) {
              sawSpeech = true;
              speechStartedAtMs = elapsedMs;
              captured.push(...preroll);
              capturedBytes += prerollBytes;
              preroll.length = 0;
              prerollBytes = 0;
              options.onSpeechStart?.();
            }
            if (event.type === "speechEnd" && sawSpeech) {
              finish(true);
              return;
            }
          }

          if (!sawSpeech && options.noSpeechReportIntervalMs !== undefined
              && elapsedMs - lastReportAtMs >= options.noSpeechReportIntervalMs) {
            lastReportAtMs = elapsedMs;
            options.onNoSpeech?.(vad.levelStats());
            vad.beginLevelWindow();
          }

          if (sawSpeech && elapsedMs - speechStartedAtMs >= options.maxDurationMs) {
            finish(true);
            return;
          }
        }
      });

      child.once("close", (code) => {
        if (settled) {
          return;
        }
        // ffmpeg ended on its own (device error, etc.). Keep whatever we have if
        // speech was detected; otherwise surface the error.
        if (sawSpeech) {
          finish(true);
          return;
        }
        settled = true;
        cleanup();
        const raw = Buffer.concat(stderr).toString("utf8").trim();
        if (code === 0 || raw === "") {
          resolve(undefined);
        } else {
          reject(new Error(raw || `ffmpeg exited with code ${code}`));
        }
      });
    });
  }
}

export function parseWindowsDshowAudioDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const seen = new Set<string>();
  const pattern = /"([^"]+)"\s+\(audio\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      devices.push({
        id: name,
        name,
        isDefault: name.toLowerCase() === "default",
      });
    }
  }

  return devices;
}

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.once("error", (err) => {
      reject(new Error(`${command} is not available: ${err.message}`));
    });

    child.once("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");

      if (code === 0 || args.includes("-list_devices")) {
        resolve({ stdout: out, stderr: err });
        return;
      }

      reject(new Error(err.trim() || `${command} exited with code ${code}`));
    });
  });
}
