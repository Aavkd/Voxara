import { AudioBuffer, AudioRecording } from "../../audio/types";
import { VoiceLanguage } from "../../types";

export type TranscriptEventType = "partial" | "final" | "error" | "end";

export type TranscriptEvent =
  | {
      type: "partial" | "final";
      text: string;
      timestampMs: number;
      raw?: string;
    }
  | {
      type: "error";
      error: Error;
      timestampMs: number;
      raw?: string;
    }
  | {
      type: "end";
      timestampMs: number;
    };

export interface STTTranscriptionOptions {
  language?: VoiceLanguage;
  signal?: AbortSignal;
}

export interface STTSetupCheck {
  ok: boolean;
  details: string;
  /** Reachable but not fully ready yet (e.g. the model is still downloading/loading). */
  warning?: boolean;
}

export type STTAudioInput = AudioBuffer | AudioRecording;

export interface WhisperCppOptions {
  binaryPath: string;
  modelPath: string;
  language: VoiceLanguage;
  sampleRate: number;
}

export interface FasterWhisperOptions {
  baseUrl: string;
  language: VoiceLanguage;
  sampleRate: number;
  timeoutMs?: number;
}

export interface STTProviderConfig {
  provider: string;
  binaryPath: string;
  modelPath: string;
  baseUrl: string;
  timeoutMs: number;
  language: VoiceLanguage;
  sampleRate: number;
}
