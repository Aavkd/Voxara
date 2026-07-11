export type AudioLifecycleState =
  | "idle"
  | "listening"
  | "speaking"
  | "interrupted"
  | "error";

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitDepth: 16;
  encoding: "pcm_s16le";
}

export interface AudioBuffer {
  data: Buffer;
  format: AudioFormat;
  container: "pcm" | "wav";
}

export interface AudioDevice {
  id: string;
  name: string;
  isDefault?: boolean;
}

export interface AudioRecording extends AudioBuffer {
  durationMs: number;
  filePath?: string;
}

export interface RecordAudioOptions {
  durationMs: number;
  sampleRate: number;
  deviceName?: string;
  keepFile?: boolean;
}

export interface RecordUtteranceOptions {
  sampleRate: number;
  deviceName?: string;
  /** VAD energy threshold (RMS, 0..1). */
  threshold: number;
  /** Continuous speech required before an utterance is considered started. */
  speechStartMs: number;
  /** Trailing silence that ends the utterance. */
  silenceEndMs: number;
  /** Hard cap on utterance length, measured from speech onset. */
  maxDurationMs: number;
  /**
   * While waiting for speech, report measured input levels via onNoSpeech every
   * this many milliseconds. The stream stays open — use `signal` to stop listening.
   */
  noSpeechReportIntervalMs?: number;
  /** Audio kept from before speech onset so the first syllables are not clipped (default 400 ms). */
  prerollMs?: number;
  frameMs?: number;
  signal?: AbortSignal;
  /** Fired once, when speech onset is detected (useful to stop assistant playback for barge-in). */
  onSpeechStart?: () => void;
  /** Use a fixed VAD threshold instead of adapting to the noise floor. */
  fixedThreshold?: boolean;
  /** Lower bound for the adaptive threshold (defaults to the VAD's built-in minimum). */
  minThreshold?: number;
  /** Noise-floor-to-speech ratio for the adaptive threshold (defaults to the VAD's built-in ratio). */
  noiseToSpeechRatio?: number;
  /** Fired on each no-speech report interval, with the levels measured since the previous report. */
  onNoSpeech?: (stats: VadLevelStats) => void;
  /** Fired for speechStart/speechEnd VAD transitions, with the levels in effect at that moment. */
  onVadEvent?: (event: VadEvent, stats: VadLevelStats) => void;
}

export interface MicrophoneCapture {
  listDevices(): Promise<AudioDevice[]>;
  record(options: RecordAudioOptions): Promise<AudioRecording>;
  /**
   * Capture a single utterance: keep one microphone stream open, wait for speech
   * onset (however long that takes), then record until trailing silence or the
   * duration cap. Resolves undefined only when aborted via `signal` before speech
   * or when the stream ends without speech.
   */
  recordUtterance(options: RecordUtteranceOptions): Promise<AudioRecording | undefined>;
}

export interface PlaybackResult {
  completed: boolean;
  interrupted: boolean;
  durationMs: number;
  stoppedInMs?: number;
}

export interface AudioOutput {
  play(audio: AudioBuffer, signal?: AbortSignal): Promise<PlaybackResult>;
  stop(): Promise<void>;
}

export interface VadConfig {
  threshold: number;
  speechStartMs: number;
  silenceEndMs: number;
  sampleRate: number;
  frameMs: number;
  /**
   * Track the ambient noise floor and derive the effective threshold from it,
   * so quiet microphones (low Windows input level) are still detected. When
   * false, `threshold` is used as a fixed cutoff.
   */
  adaptive: boolean;
  /** Lower bound for the adaptive threshold so digital silence never counts as speech. */
  minThreshold: number;
  /**
   * Speech must exceed the tracked noise floor by this factor to count as voice.
   * Raise it (e.g. 3.5) for barge-in monitoring, where constant TTS speaker
   * bleed inflates the floor and only a clearly louder voice should trigger.
   */
  noiseToSpeechRatio: number;
}

/** Measured input levels from a VAD pass, for diagnostics. All values are RMS in 0..1. */
export interface VadLevelStats {
  /** Loudest single frame seen since the last reset. */
  maxEnergy: number;
  /** Current ambient noise floor estimate (0 until the first frame is seen). */
  noiseFloor: number;
  /** Threshold in effect for the most recent frame. */
  effectiveThreshold: number;
  /** Threshold from configuration (fixed cutoff when adaptive is off). */
  configuredThreshold: number;
}

export type VadEventType = "speechStart" | "speech" | "speechEnd" | "silence";

export interface VadEvent {
  type: VadEventType;
  timestampMs: number;
  durationMs: number;
  energy: number;
}

export type TurnDetectorEvent =
  | { type: "turnStart"; timestampMs: number }
  | { type: "turnAudio"; audio: AudioBuffer; timestampMs: number }
  | { type: "turnEnd"; audio: AudioBuffer; startedAtMs: number; endedAtMs: number };
