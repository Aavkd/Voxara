import { AudioBuffer, VadConfig, VadEvent, VadLevelStats } from "./types";

export const DEFAULT_VAD_CONFIG: VadConfig = {
  threshold: 0.018,
  speechStartMs: 120,
  // Natural mid-sentence pauses (breathing, hesitation) routinely exceed 500 ms,
  // which cut utterances in half; 900 ms trades a little end-of-turn latency
  // for complete sentences.
  silenceEndMs: 900,
  sampleRate: 16000,
  frameMs: 20,
  adaptive: true,
  minThreshold: 0.002,
  noiseToSpeechRatio: 2.5,
};

/**
 * Below this peak RMS a capture is indistinguishable from a disconnected or
 * blocked microphone (DirectShow delivers near-zero noise, not real room tone).
 */
export const SILENT_CAPTURE_RMS = 0.001;

// Per-frame EMA weights: fall toward a quieter floor quickly (inter-word gaps
// re-anchor it), rise slowly so ambient noise changes are tracked between
// utterances. The rise is frozen entirely while speech is active — otherwise a
// long continuous sentence lifts the floor until the threshold overtakes the
// speaker's own voice and the utterance is cut mid-phrase.
const NOISE_FLOOR_FALL = 0.7;
const NOISE_FLOOR_RISE = 0.002;

export class EnergyVad {
  private readonly config: VadConfig;
  private inSpeech = false;
  private speechMs = 0;
  private silenceMs = 0;
  private elapsedMs = 0;
  private noiseFloor: number | undefined;
  private maxEnergy = 0;
  private effectiveThreshold: number;

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    this.effectiveThreshold = this.config.threshold;
  }

  process(audio: AudioBuffer): VadEvent[] {
    if (audio.container !== "pcm") {
      throw new Error("EnergyVad expects raw PCM audio chunks");
    }

    const durationMs = durationFromPcm(audio.data, audio.format.sampleRate, audio.format.channels);
    const energy = calculatePcm16Rms(audio.data);
    const isVoice = energy >= this.updateThreshold(energy);
    const events: VadEvent[] = [];

    if (energy > this.maxEnergy) {
      this.maxEnergy = energy;
    }

    this.elapsedMs += durationMs;

    if (isVoice) {
      this.speechMs += durationMs;
      this.silenceMs = 0;

      if (!this.inSpeech && this.speechMs >= this.config.speechStartMs) {
        this.inSpeech = true;
        events.push({
          type: "speechStart",
          timestampMs: this.elapsedMs - this.speechMs,
          durationMs: this.speechMs,
          energy,
        });
      }

      events.push({
        type: this.inSpeech ? "speech" : "silence",
        timestampMs: this.elapsedMs,
        durationMs,
        energy,
      });
    } else {
      this.silenceMs += durationMs;
      this.speechMs = this.inSpeech ? this.speechMs : 0;

      if (this.inSpeech && this.silenceMs >= this.config.silenceEndMs) {
        this.inSpeech = false;
        events.push({
          type: "speechEnd",
          timestampMs: this.elapsedMs,
          durationMs: this.silenceMs,
          energy,
        });
        this.speechMs = 0;
        this.silenceMs = 0;
      } else {
        events.push({
          type: "silence",
          timestampMs: this.elapsedMs,
          durationMs,
          energy,
        });
      }
    }

    return events;
  }

  reset(): void {
    this.inSpeech = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.elapsedMs = 0;
    this.noiseFloor = undefined;
    this.maxEnergy = 0;
    this.effectiveThreshold = this.config.threshold;
  }

  /** Start a fresh measurement window for maxEnergy without touching VAD state. */
  beginLevelWindow(): void {
    this.maxEnergy = 0;
  }

  levelStats(): VadLevelStats {
    return {
      maxEnergy: this.maxEnergy,
      noiseFloor: this.noiseFloor ?? 0,
      effectiveThreshold: this.effectiveThreshold,
      configuredThreshold: this.config.threshold,
    };
  }

  private updateThreshold(energy: number): number {
    if (!this.config.adaptive) {
      this.effectiveThreshold = this.config.threshold;
      return this.effectiveThreshold;
    }

    if (this.noiseFloor === undefined) {
      // Seed at or below the configured threshold so the first frames behave
      // like the fixed cutoff, then adapt to what the microphone actually delivers.
      this.noiseFloor = Math.min(energy, this.config.threshold / this.config.noiseToSpeechRatio);
    } else if (energy < this.noiseFloor) {
      this.noiseFloor = this.noiseFloor * (1 - NOISE_FLOOR_FALL) + energy * NOISE_FLOOR_FALL;
    } else if (!this.inSpeech) {
      this.noiseFloor += (energy - this.noiseFloor) * NOISE_FLOOR_RISE;
    }

    this.effectiveThreshold = Math.max(this.config.minThreshold, this.noiseFloor * this.config.noiseToSpeechRatio);
    return this.effectiveThreshold;
  }
}

export function calculatePcm16Rms(buffer: Buffer): number {
  if (buffer.length < 2) {
    return 0;
  }

  let sumSquares = 0;
  const sampleCount = Math.floor(buffer.length / 2);

  for (let offset = 0; offset < sampleCount * 2; offset += 2) {
    const sample = buffer.readInt16LE(offset) / 32768;
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
}

export function durationFromPcm(buffer: Buffer, sampleRate: number, channels: number): number {
  const samples = buffer.length / 2 / channels;
  return (samples / sampleRate) * 1000;
}
