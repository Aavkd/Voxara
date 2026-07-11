import { PassThrough } from "stream";
import { EventEmitter } from "events";
import { createSineWavePcm16, decodePcm16Wav } from "../src/audio/wav";
import { PiperTTSProvider } from "../src/speech/tts/piperTts";
import { SupertonicTTSProvider } from "../src/speech/tts/supertonicTts";
import { collectTTSAudioEvents } from "../src/speech/tts/factory";

const PIPER_FORMAT = { sampleRate: 22050, channels: 1, bitDepth: 16, encoding: "pcm_s16le" } as const;
const piperVoiceConfig = (() => JSON.stringify({ audio: { sample_rate: 22050 } })) as never;

describe("PiperTTSProvider", () => {
  it("wraps raw PCM into a well-formed WAV without altering samples, keeps chunk ordering", async () => {
    const pcm = createSineWavePcm16(440, 20, PIPER_FORMAT);
    const provider = new PiperTTSProvider({ binaryPath: "piper.exe", voice: "voice.onnx", language: "fr" }, {
      existsSync: () => true,
      readFileSync: piperVoiceConfig,
      spawn: (() => mockPiperProcess(pcm)) as never,
    });
    const result = await provider.synthesize("Bonjour.");
    expect(result.audio.container).toBe("wav");
    expect(result.audio.format.sampleRate).toBe(22050);
    const decoded = decodePcm16Wav(result.audio.data);
    expect(decoded.format.sampleRate).toBe(22050);
    expect(decoded.format.channels).toBe(1);
    // Byte-identity regression test for the Windows CRLF stdout corruption.
    expect(Buffer.compare(decoded.data, pcm)).toBe(0);
    const events = await collectTTSAudioEvents(provider.synthesizeChunks(["Premier.", "Second."]));
    expect(events.filter((event) => event.type === "audio").map((event) => event.type === "audio" ? event.text : "")).toEqual(["Premier.", "Second."]);
  });

  it("strips markdown markup that espeak-ng would read out loud", async () => {
    const pcm = createSineWavePcm16(440, 20, PIPER_FORMAT);
    const stdinTexts: string[] = [];
    const provider = new PiperTTSProvider({ binaryPath: "piper.exe", voice: "voice.onnx", language: "fr" }, {
      existsSync: () => true,
      readFileSync: piperVoiceConfig,
      spawn: (() => mockPiperProcess(pcm, stdinTexts)) as never,
    });
    const events = await collectTTSAudioEvents(provider.synthesizeChunks(["**Bonjour** le *monde*.", "* ", "# Titre `code`"]));
    const audioEvents = events.filter((event) => event.type === "audio");
    // The markup-only chunk is skipped instead of failing the stream.
    expect(audioEvents.map((event) => event.type === "audio" ? event.text : "")).toEqual(["Bonjour le monde.", "Titre code"]);
    expect(stdinTexts).toEqual(["Bonjour le monde.\n", "Titre code\n"]);
    await expect(provider.synthesize("**")).rejects.toThrow("empty text");
  });

  it("rejects a malformed PCM stream with an odd byte count", async () => {
    const provider = new PiperTTSProvider({ binaryPath: "piper.exe", voice: "voice.onnx", language: "fr" }, {
      existsSync: () => true,
      readFileSync: piperVoiceConfig,
      spawn: (() => mockPiperProcess(Buffer.from([0x01, 0x02, 0x03]))) as never,
    });
    await expect(provider.synthesize("Bonjour.")).rejects.toThrow("odd byte count");
  });

  it("rejects a voice config without a valid sample rate", async () => {
    const provider = new PiperTTSProvider({ binaryPath: "piper.exe", voice: "voice.onnx", language: "fr" }, {
      existsSync: () => true,
      readFileSync: (() => JSON.stringify({ audio: {} })) as never,
      spawn: (() => mockPiperProcess(Buffer.alloc(4))) as never,
    });
    await expect(provider.synthesize("Bonjour.")).rejects.toThrow("audio.sample_rate");
  });

  it("rejects empty text and pre-aborted synthesis", async () => {
    const provider = new PiperTTSProvider({ binaryPath: "piper.exe", voice: "voice.onnx", language: "fr" }, { existsSync: () => true });
    await expect(provider.synthesize(" ")).rejects.toThrow("empty text");
    const controller = new AbortController();
    controller.abort();
    await expect(provider.synthesize("Bonjour", { signal: controller.signal })).rejects.toThrow("cancelled");
  });
});

describe("SupertonicTTSProvider", () => {
  it("uses the CPU helper output and emits 44.1 kHz WAV", async () => {
    const loadSdk = jest.fn(async () => ({
      loadTextToSpeech: async () => ({ sampleRate: 44100, call: async () => ({ wav: new Float32Array([0, 0.5, -0.5]) }) }),
      loadVoiceStyle: () => ({ style: true }),
    }));
    const provider = new SupertonicTTSProvider({ assetsDir: "assets", voice: "F1", language: "fr" }, {
      existsSync: () => true,
      loadSdk,
    });
    const result = await provider.synthesize("Bonjour");
    expect(result.audio.container).toBe("wav");
    expect(result.audio.format.sampleRate).toBe(44100);
    expect(loadSdk).toHaveBeenCalledTimes(1);
    const events = await collectTTSAudioEvents(provider.synthesizeChunks(["Un.", "Deux."]));
    expect(events.map((event) => event.type)).toEqual(["audio", "audio", "end"]);
  });

  it("loads each voice style once and reuses it across chunks", async () => {
    const loadVoiceStyle = jest.fn(() => ({ style: true }));
    const loadSdk = jest.fn(async () => ({
      loadTextToSpeech: async () => ({ sampleRate: 44100, call: async () => ({ wav: new Float32Array([0, 0.5, -0.5]) }) }),
      loadVoiceStyle,
    }));
    const provider = new SupertonicTTSProvider({ assetsDir: "assets", voice: "F1", language: "fr" }, {
      existsSync: () => true,
      loadSdk,
    });

    await collectTTSAudioEvents(provider.synthesizeChunks(["Un.", "Deux.", "Trois."]));
    expect(loadVoiceStyle).toHaveBeenCalledTimes(1);

    await provider.synthesize("Encore", { voice: "M1" });
    expect(loadVoiceStyle).toHaveBeenCalledTimes(2);
  });
});

function mockPiperProcess(pcm: Buffer, stdinTexts?: string[]): unknown {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void; killed: boolean };
  child.stdin = new PassThrough();
  if (stdinTexts) child.stdin.on("data", (chunk: Buffer) => stdinTexts.push(chunk.toString("utf8")));
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit("close", null); };
  queueMicrotask(() => {
    child.stdout.end(pcm);
    child.emit("close", 0);
  });
  return child;
}
