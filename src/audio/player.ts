import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { AudioBuffer, AudioLifecycleState, AudioOutput, PlaybackResult } from "./types";
import { encodePcm16Wav } from "./wav";

interface QueueItem {
  audio: AudioBuffer;
  resolve: (result: PlaybackResult) => void;
  reject: (err: unknown) => void;
}

export class CancellablePlaybackQueue {
  private readonly output: AudioOutput;
  private queue: QueueItem[] = [];
  private active?: QueueItem;
  private activeController?: AbortController;
  private activeSettled?: Promise<void>;
  private playing = false;
  private currentState: AudioLifecycleState = "idle";

  constructor(output: AudioOutput) {
    this.output = output;
  }

  get state(): AudioLifecycleState {
    return this.currentState;
  }

  play(audio: AudioBuffer): Promise<PlaybackResult> {
    const promise = new Promise<PlaybackResult>((resolve, reject) => {
      this.queue.push({ audio, resolve, reject });
    });

    void this.drain();
    return promise;
  }

  async stop(): Promise<number> {
    const startedAt = Date.now();
    this.flushPending(startedAt);

    if (this.activeController) {
      this.activeController.abort();
    }

    await this.output.stop();

    if (this.activeSettled) {
      await Promise.race([this.activeSettled, delay(200)]);
    }

    this.currentState = "interrupted";
    return Date.now() - startedAt;
  }

  flush(): void {
    this.flushPending(Date.now());
  }

  private async drain(): Promise<void> {
    if (this.playing) {
      return;
    }

    this.playing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) {
        break;
      }

      this.active = item;
      this.activeController = new AbortController();
      this.currentState = "speaking";

      this.activeSettled = this.output
        .play(item.audio, this.activeController.signal)
        .then((result) => {
          if (!result.interrupted && this.queue.length === 0) {
            this.currentState = "idle";
          }
          item.resolve(result);
        })
        .catch((err) => {
          if (this.activeController?.signal.aborted) {
            item.resolve({
              completed: false,
              interrupted: true,
              durationMs: 0,
            });
            return;
          }
          this.currentState = "error";
          item.reject(err);
        })
        .finally(() => {
          this.active = undefined;
          this.activeController = undefined;
        });

      await this.activeSettled;
    }

    this.playing = false;
    if (this.currentState !== "error" && this.currentState !== "interrupted") {
      this.currentState = "idle";
    }
  }

  private flushPending(stoppedAt: number): void {
    const pending = this.queue.splice(0);
    for (const item of pending) {
      item.resolve({
        completed: false,
        interrupted: true,
        durationMs: 0,
        stoppedInMs: Date.now() - stoppedAt,
      });
    }
  }
}

export class SystemAudioOutput implements AudioOutput {
  private currentProcess?: ChildProcessWithoutNullStreams;
  private persistentProcess?: ChildProcessWithoutNullStreams;
  private readonly pendingPersistent = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private persistentFailed = false;

  async play(audio: AudioBuffer, signal?: AbortSignal): Promise<PlaybackResult> {
    const startedAt = Date.now();
    const wav = audio.container === "wav" ? audio.data : encodePcm16Wav(audio.data, audio.format);
    const filePath = path.join(os.tmpdir(), `llmtest-tone-${process.pid}-${Date.now()}.wav`);
    fs.writeFileSync(filePath, wav);

    try {
      await this.playWavFile(filePath, signal);
      return {
        completed: !signal?.aborted,
        interrupted: Boolean(signal?.aborted),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  }

  async stop(): Promise<void> {
    if (this.persistentProcess && !this.persistentProcess.killed) {
      this.persistentProcess.kill();
    }
    if (this.currentProcess && !this.currentProcess.killed) {
      this.currentProcess.kill();
    }
  }

  private async playWavFile(filePath: string, signal?: AbortSignal): Promise<void> {
    if (process.platform === "win32" && !this.persistentFailed) {
      try {
        await this.playWithPersistentPowerShell(filePath, signal);
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        this.persistentFailed = true;
        await this.stopPersistent();
      }
    }
    return this.playWavFileFallback(filePath, signal);
  }

  private playWavFileFallback(filePath: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = process.platform === "win32"
        ? spawn("powershell.exe", [
            "-NoProfile",
            "-Command",
            `$p = New-Object System.Media.SoundPlayer '${escapePowerShellPath(filePath)}'; $p.PlaySync();`,
          ])
        : spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath]);

      this.currentProcess = child;

      const abort = () => {
        if (!child.killed) {
          child.kill();
        }
      };

      signal?.addEventListener("abort", abort, { once: true });

      child.once("error", (err) => {
        signal?.removeEventListener("abort", abort);
        this.currentProcess = undefined;
        reject(err);
      });

      child.once("close", (code) => {
        signal?.removeEventListener("abort", abort);
        this.currentProcess = undefined;
        if (signal?.aborted || code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Audio playback command exited with code ${code}`));
        }
      });
    });
  }

  private playWithPersistentPowerShell(filePath: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.ensurePersistentPlayer();
      const abort = () => {
        this.pendingPersistent.delete(filePath);
        if (!child.killed) child.kill();
        reject(new Error("Audio playback was interrupted."));
      };
      this.pendingPersistent.set(filePath, {
        resolve: () => { signal?.removeEventListener("abort", abort); resolve(); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(`${filePath}\n`, "utf8", (error) => {
        if (error) {
          this.pendingPersistent.delete(filePath);
          signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
    });
  }

  private ensurePersistentPlayer(): ChildProcessWithoutNullStreams {
    if (this.persistentProcess && !this.persistentProcess.killed) return this.persistentProcess;
    const script = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "while (($wav = [Console]::In.ReadLine()) -ne $null) {",
      "  if ($wav.Length -eq 0) { continue }",
      "  try { $player = New-Object System.Media.SoundPlayer $wav; $player.PlaySync(); Write-Output ('DONE ' + $wav) }",
      "  catch { Write-Output ('ERROR ' + $wav + ' ' + $_.Exception.Message) }",
      "}",
    ].join("; ");
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "pipe", windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) this.handlePersistentLine(line);
    });
    child.once("error", (error) => this.failPersistent(error));
    child.once("close", () => this.failPersistent(new Error("Persistent audio player stopped.")));
    this.persistentProcess = child;
    return child;
  }

  private handlePersistentLine(line: string): void {
    const matched = /^(DONE|ERROR)\s+(.+?)(?:\s+(.+))?$/.exec(line.trim());
    if (!matched) return;
    // Paths may contain spaces. Match the registered path rather than relying
    // on the optional error-message split above.
    const filePath = [...this.pendingPersistent.keys()].find((value) => line.includes(value));
    if (!filePath) return;
    const pending = this.pendingPersistent.get(filePath);
    this.pendingPersistent.delete(filePath);
    if (!pending) return;
    if (matched[1] === "DONE") pending.resolve();
    else pending.reject(new Error(line.slice("ERROR ".length + filePath.length).trim() || "Persistent audio playback failed."));
  }

  private failPersistent(error: Error): void {
    if (!this.persistentProcess && this.pendingPersistent.size === 0) return;
    this.persistentProcess = undefined;
    const pending = [...this.pendingPersistent.values()];
    this.pendingPersistent.clear();
    for (const item of pending) item.reject(error);
  }

  private async stopPersistent(): Promise<void> {
    if (this.persistentProcess && !this.persistentProcess.killed) this.persistentProcess.kill();
    this.persistentProcess = undefined;
  }
}

function escapePowerShellPath(filePath: string): string {
  return filePath.replace(/'/g, "''");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
