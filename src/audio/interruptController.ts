import { CancellablePlaybackQueue } from "./player";
import { AudioBuffer, VadConfig } from "./types";
import { decodePcm16Wav } from "./wav";
import { EnergyVad } from "./vad";

export interface InterruptControllerOptions {
  enabled: boolean;
  vad: Partial<VadConfig>;
  cooldownMs?: number;
  now?: () => number;
}

export interface InterruptionResult {
  interrupted: boolean;
  stoppedInMs?: number;
  reason?: string;
}

export class InterruptController {
  private readonly playback: CancellablePlaybackQueue;
  private readonly vad: EnergyVad;
  private readonly enabled: boolean;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private lastInterruptedAt = 0;

  constructor(playback: CancellablePlaybackQueue, options: InterruptControllerOptions) {
    this.playback = playback;
    this.vad = new EnergyVad(options.vad);
    this.enabled = options.enabled;
    this.cooldownMs = options.cooldownMs ?? 300;
    this.now = options.now ?? Date.now;
  }

  async inspect(audio: AudioBuffer): Promise<InterruptionResult> {
    if (!this.enabled) {
      return { interrupted: false };
    }

    if (this.now() - this.lastInterruptedAt < this.cooldownMs) {
      return { interrupted: false };
    }

    const pcm = audio.container === "wav" ? decodePcm16Wav(audio.data) : audio;
    const events = this.vad.process(pcm);
    const hasSpeechStart = events.some((event) => event.type === "speechStart");

    if (!hasSpeechStart) {
      return { interrupted: false };
    }

    const stoppedInMs = await this.interrupt("barge-in");
    return {
      interrupted: true,
      stoppedInMs,
      reason: "barge-in",
    };
  }

  async interrupt(reason = "manual"): Promise<number> {
    this.lastInterruptedAt = this.now();
    const stoppedInMs = await this.playback.stop();
    this.playback.flush();
    this.vad.reset();
    return stoppedInMs;
  }

  reset(): void {
    this.vad.reset();
    this.lastInterruptedAt = 0;
  }
}
