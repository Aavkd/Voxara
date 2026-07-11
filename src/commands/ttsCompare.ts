import { CancellablePlaybackQueue, SystemAudioOutput } from "../audio/player";
import { loadVoiceConfig } from "../config/loader";
import { createTTSProvider } from "../speech/tts/factory";
import { VoiceConfig } from "../types";

const DEFAULT_TEXT = "Bonjour. Ceci est un test court de synthese vocale. Je lis aussi une phrase un peu plus longue, pour comparer la clarte, le rythme et le naturel de chaque voix.";

export async function ttsCompareCommand(text?: string): Promise<void> {
  const baseVoice = loadVoiceConfig();
  const phrase = text?.trim() || DEFAULT_TEXT;
  const candidates: Array<{ provider: string; voice: string }> = [
    { provider: "piper", voice: baseVoice.piperVoice || "./models/piper/fr_FR-siwis-medium.onnx" },
    { provider: "piper", voice: "./models/piper/fr_FR-upmc-medium.onnx" },
    { provider: "piper", voice: "./models/piper/fr_FR-tom-medium.onnx" },
    { provider: "supertonic", voice: "F1" },
    { provider: "supertonic", voice: "M1" },
    { provider: "qwen3-tts", voice: "voice-style prompt" },
  ];
  const player = new CancellablePlaybackQueue(new SystemAudioOutput());

  try {
    for (const candidate of candidates) {
      const voice = makeVoiceConfig(baseVoice, candidate.provider, candidate.voice);
      const provider = createTTSProvider(voice);
      console.log(`\n[${provider.name} / ${candidate.voice}]`);
      const setup = await provider.checkSetup();
      if (!setup.ok) {
        console.log(`Skipped: ${setup.details}`);
        continue;
      }
      const result = await provider.synthesize(phrase, { language: voice.language });
      console.log(`Synthesized in ${result.latencyMs} ms; playing now.`);
      await player.play(result.audio);
    }
  } finally {
    await player.stop();
  }
}

function makeVoiceConfig(base: VoiceConfig, provider: string, selectedVoice: string): VoiceConfig {
  const config: VoiceConfig = { ...base, ttsProvider: provider };
  if (provider === "piper") config.piperVoice = selectedVoice;
  if (provider === "supertonic") config.supertonicVoice = selectedVoice;
  return config;
}
