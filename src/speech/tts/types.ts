import { AudioBuffer } from "../../audio/types";
import { VoiceLanguage } from "../../types";

export type TTSEventType = "audio" | "error" | "end";

export type TTSEvent =
  | {
      type: "audio";
      audio: AudioBuffer;
      text: string;
      chunkIndex: number;
      timestampMs: number;
      /** Time spent synthesizing this chunk, excluding queueing/playback. */
      latencyMs?: number;
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

export interface TTSSynthesisOptions {
  language?: VoiceLanguage;
  voiceDesignPrompt?: string;
  /** Provider-specific voice override, e.g. a Piper model path or Supertonic preset. */
  voice?: string;
  /** Numeric Piper speaker id for multi-speaker models. */
  speaker?: number;
  signal?: AbortSignal;
}

export interface TTSAudioResult {
  audio: AudioBuffer;
  latencyMs: number;
  bytes: number;
  contentType?: string;
}

export interface TTSSetupCheck {
  ok: boolean;
  details: string;
  /** Reachable but not fully ready yet (e.g. the model is still downloading/loading). */
  warning?: boolean;
}

export interface TTSProviderConfig {
  provider: string;
  baseUrl: string;
  model: string;
  language: VoiceLanguage;
  sampleRate: number;
  promptsDir: string;
}

export interface Qwen3TTSOptions {
  baseUrl: string;
  model: string;
  language: VoiceLanguage;
  sampleRate: number;
  timeoutMs?: number;
}

export interface PiperTTSOptions {
  binaryPath: string;
  voice: string;
  speaker?: number;
  language: VoiceLanguage;
  timeoutMs?: number;
}

export interface SupertonicTTSOptions {
  assetsDir: string;
  voice: string;
  language: VoiceLanguage;
  timeoutMs?: number;
  totalSteps?: number;
  speed?: number;
}

export interface TTSChunkingOptions {
  maxChars?: number;
  minChars?: number;
}
