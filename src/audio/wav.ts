import { AudioBuffer, AudioFormat } from "./types";

export const PCM16_MONO_16KHZ: AudioFormat = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  encoding: "pcm_s16le",
};

export function createSineWavePcm16(
  frequencyHz: number,
  durationMs: number,
  format: AudioFormat = PCM16_MONO_16KHZ,
  amplitude = 0.25
): Buffer {
  const sampleCount = Math.floor((durationMs / 1000) * format.sampleRate);
  const buffer = Buffer.alloc(sampleCount * format.channels * 2);
  const clampedAmplitude = Math.max(0, Math.min(1, amplitude));

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const value = Math.sin((2 * Math.PI * frequencyHz * sampleIndex) / format.sampleRate);
    const pcmValue = Math.max(-1, Math.min(1, value * clampedAmplitude));
    const intValue = Math.round(pcmValue * 32767);

    for (let channel = 0; channel < format.channels; channel += 1) {
      buffer.writeInt16LE(intValue, (sampleIndex * format.channels + channel) * 2);
    }
  }

  return buffer;
}

export function createSilencePcm16(
  durationMs: number,
  format: AudioFormat = PCM16_MONO_16KHZ
): Buffer {
  const sampleCount = Math.floor((durationMs / 1000) * format.sampleRate);
  return Buffer.alloc(sampleCount * format.channels * 2);
}

export function encodePcm16Wav(pcm: Buffer, format: AudioFormat): Buffer {
  const bytesPerSample = format.bitDepth / 8;
  const byteRate = format.sampleRate * format.channels * bytesPerSample;
  const blockAlign = format.channels * bytesPerSample;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.bitDepth, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export function createToneWav(
  frequencyHz = 440,
  durationMs = 500,
  format: AudioFormat = PCM16_MONO_16KHZ,
  amplitude = 0.25
): AudioBuffer {
  const pcm = createSineWavePcm16(frequencyHz, durationMs, format, amplitude);
  return {
    data: encodePcm16Wav(pcm, format),
    format,
    container: "wav",
  };
}

export function decodePcm16Wav(wav: Buffer): AudioBuffer {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid WAV data: missing RIFF/WAVE header");
  }

  const fmtOffset = wav.indexOf("fmt ");
  const dataOffset = wav.indexOf("data");
  if (fmtOffset < 0 || dataOffset < 0) {
    throw new Error("Invalid WAV data: missing fmt or data chunk");
  }

  const channels = wav.readUInt16LE(fmtOffset + 10);
  const sampleRate = wav.readUInt32LE(fmtOffset + 12);
  const bitDepth = wav.readUInt16LE(fmtOffset + 22);
  const dataLength = wav.readUInt32LE(dataOffset + 4);
  const dataStart = dataOffset + 8;

  if (bitDepth !== 16) {
    throw new Error(`Unsupported WAV bit depth: ${bitDepth}`);
  }

  return {
    data: wav.subarray(dataStart, dataStart + dataLength),
    format: {
      sampleRate,
      channels,
      bitDepth: 16,
      encoding: "pcm_s16le",
    },
    container: "pcm",
  };
}

