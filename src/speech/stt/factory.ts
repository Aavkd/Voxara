import { VoiceConfig } from "../../types";
import { ISTTProvider } from "./ISTTProvider";
import { WhisperCppSTTProvider } from "./whisperCpp";
import { FasterWhisperHttpSTTProvider } from "./fasterWhisperHttp";
import { STTProviderConfig } from "./types";

const DEFAULT_WHISPER_CPP_BINARY = "whisper-cli";
const DEFAULT_FASTER_WHISPER_BASE_URL = "http://localhost:7862";

export function createSTTProvider(config: VoiceConfig): ISTTProvider {
  const sttConfig = resolveSTTProviderConfig(config);

  if (sttConfig.provider === "faster-whisper") {
    return new FasterWhisperHttpSTTProvider({
      baseUrl: sttConfig.baseUrl,
      language: sttConfig.language,
      sampleRate: sttConfig.sampleRate,
      timeoutMs: sttConfig.timeoutMs,
    });
  }

  if (sttConfig.provider === "whisper-cpp") {
    return new WhisperCppSTTProvider({
      binaryPath: sttConfig.binaryPath,
      modelPath: sttConfig.modelPath,
      language: sttConfig.language,
      sampleRate: sttConfig.sampleRate,
    });
  }

  throw new Error(
    `Unsupported STT provider "${config.sttProvider}". Supported providers: faster-whisper, whisper-cpp.`
  );
}

export function resolveSTTProviderConfig(config: VoiceConfig): STTProviderConfig {
  return {
    provider: config.sttProvider,
    binaryPath: config.sttBinaryPath || DEFAULT_WHISPER_CPP_BINARY,
    modelPath: config.sttModelPath,
    baseUrl: config.sttBaseUrl || DEFAULT_FASTER_WHISPER_BASE_URL,
    timeoutMs: config.sttTimeoutMs,
    language: config.language,
    sampleRate: config.sampleRate,
  };
}

export async function collectFinalTranscript(
  events: AsyncIterable<{ type: string; text?: string; error?: Error }>
): Promise<string> {
  let finalText = "";
  let firstError: Error | undefined;

  for await (const event of events) {
    if (event.type === "final" && event.text) {
      finalText = event.text;
    }
    if (event.type === "error" && event.error && !firstError) {
      firstError = event.error;
    }
  }

  if (firstError) {
    throw firstError;
  }

  return finalText;
}
