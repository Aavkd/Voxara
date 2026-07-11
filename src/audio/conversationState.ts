import { AudioLifecycleState } from "./types";

export type VoiceConversationStatus =
  | "starting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "muted"
  | "error"
  | "stopped";

export interface VoiceLatencyMetrics {
  sttFinalMs?: number;
  llmFirstTokenMs?: number;
  ttsFirstAudioMs?: number;
  playbackStopMs?: number;
  endToEndMs?: number;
}

export interface VoiceConversationSnapshot {
  status: VoiceConversationStatus;
  audioState: AudioLifecycleState;
  turnIndex: number;
  muted: boolean;
  debug: boolean;
  lastError?: string;
  metrics: VoiceLatencyMetrics;
}

export class VoiceConversationState {
  private statusValue: VoiceConversationStatus = "starting";
  private audioStateValue: AudioLifecycleState = "idle";
  private turnIndexValue = 0;
  private mutedValue = false;
  private debugValue = false;
  private lastErrorValue?: string;
  private metricsValue: VoiceLatencyMetrics = {};

  constructor(options: { debug?: boolean } = {}) {
    this.debugValue = Boolean(options.debug);
  }

  get status(): VoiceConversationStatus {
    return this.statusValue;
  }

  get turnIndex(): number {
    return this.turnIndexValue;
  }

  beginTurn(): number {
    this.turnIndexValue += 1;
    this.metricsValue = {};
    this.lastErrorValue = undefined;
    return this.turnIndexValue;
  }

  setStatus(status: VoiceConversationStatus, audioState?: AudioLifecycleState): void {
    this.statusValue = status;
    if (audioState) {
      this.audioStateValue = audioState;
    }
  }

  setMuted(muted: boolean): void {
    this.mutedValue = muted;
    this.statusValue = muted ? "muted" : "listening";
  }

  setDebug(debug: boolean): void {
    this.debugValue = debug;
  }

  setError(error: unknown): void {
    this.statusValue = "error";
    this.audioStateValue = "error";
    this.lastErrorValue = error instanceof Error ? error.message : String(error);
  }

  markMetric(name: keyof VoiceLatencyMetrics, value: number): void {
    this.metricsValue[name] = value;
  }

  snapshot(): VoiceConversationSnapshot {
    return {
      status: this.statusValue,
      audioState: this.audioStateValue,
      turnIndex: this.turnIndexValue,
      muted: this.mutedValue,
      debug: this.debugValue,
      lastError: this.lastErrorValue,
      metrics: { ...this.metricsValue },
    };
  }
}
