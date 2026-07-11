import { CancellablePlaybackQueue } from "../../audio/player";
import { PlaybackResult } from "../../audio/types";
import { VoiceConfig } from "../../types";
import { renderPrompt } from "../../prompts/promptLoader";
import { ITTSProvider } from "./ITTSProvider";
import { Qwen3TTSProvider } from "./qwen3Tts";
import { PiperTTSProvider } from "./piperTts";
import { SupertonicTTSProvider } from "./supertonicTts";
import { TTSEvent, TTSProviderConfig } from "./types";

export function createTTSProvider(config: VoiceConfig): ITTSProvider {
  const ttsConfig = resolveTTSProviderConfig(config);

  if (ttsConfig.provider === "qwen3-tts") {
    return new Qwen3TTSProvider({
      baseUrl: ttsConfig.baseUrl,
      model: ttsConfig.model,
      language: ttsConfig.language,
      sampleRate: ttsConfig.sampleRate,
      timeoutMs: config.ttsTimeoutMs,
    });
  }

  if (ttsConfig.provider === "piper") {
    return new PiperTTSProvider({
      binaryPath: config.piperBinaryPath || "./tools/piper/bin/piper.exe",
      voice: config.piperVoice || "./models/piper/fr_FR-siwis-medium.onnx",
      speaker: config.piperSpeaker,
      language: ttsConfig.language,
      timeoutMs: config.ttsTimeoutMs,
    });
  }

  if (ttsConfig.provider === "supertonic") {
    return new SupertonicTTSProvider({
      assetsDir: config.supertonicAssetsDir || "./models/supertonic",
      voice: config.supertonicVoice || "F1",
      language: ttsConfig.language,
      timeoutMs: config.ttsTimeoutMs,
    });
  }

  throw new Error(
    `Unsupported TTS provider "${config.ttsProvider}". Supported providers: piper, supertonic, qwen3-tts.`
  );
}

export function resolveTTSProviderConfig(config: VoiceConfig): TTSProviderConfig {
  return {
    provider: config.ttsProvider,
    baseUrl: config.ttsBaseUrl,
    model: config.ttsModel,
    language: config.language,
    sampleRate: config.sampleRate,
    promptsDir: config.promptsDir,
  };
}

export function loadVoiceDesignPrompt(config: VoiceConfig): string {
  return renderPrompt("voice-style", {}, { promptsDir: config.promptsDir });
}

export async function synthesizeTextToPlayback(
  provider: ITTSProvider,
  queue: CancellablePlaybackQueue,
  text: string,
  options: {
    voiceDesignPrompt: string;
    language: VoiceConfig["language"];
    signal?: AbortSignal;
  }
): Promise<{ chunks: number; queued: number; interrupted: number }> {
  let chunks = 0;
  let queued = 0;
  const playbackResults: Array<Promise<PlaybackResult>> = [];

  for await (const event of provider.synthesizeChunks(chunkTextForTTS(text), options)) {
    if (event.type === "audio") {
      chunks += 1;
      playbackResults.push(queue.play(event.audio));
      queued += 1;
    } else if (event.type === "error") {
      throw event.error;
    }
  }

  const settledPlayback = await Promise.all(playbackResults);
  const interrupted = settledPlayback.filter((result) => result.interrupted).length;

  return { chunks, queued, interrupted };
}

export function chunkTextForTTS(text: string, options: { maxChars?: number; minChars?: number } = {}): string[] {
  const maxChars = options.maxChars ?? 240;
  const minChars = options.minChars ?? 60;
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return [];
  }

  const sentences = splitSentences(normalized);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitLongSentence(sentence, maxChars));
      continue;
    }

    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length <= maxChars || current.length < minChars) {
      current = next;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export async function collectTTSAudioEvents(events: AsyncIterable<TTSEvent>): Promise<TTSEvent[]> {
  const collected: TTSEvent[] = [];
  let firstError: Error | undefined;

  for await (const event of events) {
    collected.push(event);
    if (event.type === "error" && !firstError) {
      firstError = event.error;
    }
  }

  if (firstError) {
    throw firstError;
  }

  return collected;
}

function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?;:]+[.!?;:]*/g);
  return (matches || [text])
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function splitLongSentence(sentence: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const word of sentence.split(" ")) {
    if (word.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let offset = 0; offset < word.length; offset += maxChars) {
        chunks.push(word.slice(offset, offset + maxChars));
      }
      continue;
    }

    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}
