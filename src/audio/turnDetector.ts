import { AudioBuffer, TurnDetectorEvent, VadConfig } from "./types";
import { EnergyVad } from "./vad";

export class AudioTurnDetector {
  private readonly vad: EnergyVad;
  private readonly chunks: Buffer[] = [];
  private inTurn = false;
  private startedAtMs = 0;

  constructor(config: Partial<VadConfig> = {}) {
    this.vad = new EnergyVad(config);
  }

  process(audio: AudioBuffer): TurnDetectorEvent[] {
    const vadEvents = this.vad.process(audio);
    const events: TurnDetectorEvent[] = [];

    for (const event of vadEvents) {
      if (event.type === "speechStart" && !this.inTurn) {
        this.inTurn = true;
        this.startedAtMs = event.timestampMs;
        this.chunks.length = 0;
        events.push({ type: "turnStart", timestampMs: event.timestampMs });
      }
    }

    if (this.inTurn) {
      this.chunks.push(audio.data);
      events.push({ type: "turnAudio", audio, timestampMs: Date.now() });
    }

    for (const event of vadEvents) {
      if (event.type === "speechEnd" && this.inTurn) {
        const data = Buffer.concat(this.chunks);
        this.chunks.length = 0;
        this.inTurn = false;
        events.push({
          type: "turnEnd",
          startedAtMs: this.startedAtMs,
          endedAtMs: event.timestampMs,
          audio: {
            data,
            format: audio.format,
            container: "pcm",
          },
        });
      }
    }

    return events;
  }

  reset(): void {
    this.vad.reset();
    this.chunks.length = 0;
    this.inTurn = false;
    this.startedAtMs = 0;
  }
}
