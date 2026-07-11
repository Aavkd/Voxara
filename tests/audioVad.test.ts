import { AudioTurnDetector } from "../src/audio/turnDetector";
import { AudioBuffer } from "../src/audio/types";
import { EnergyVad } from "../src/audio/vad";
import { PCM16_MONO_16KHZ, createSilencePcm16, createSineWavePcm16 } from "../src/audio/wav";

describe("EnergyVad", () => {
  it("emits speech start and speech end from PCM energy", () => {
    const vad = new EnergyVad({
      sampleRate: 16000,
      threshold: 0.05,
      speechStartMs: 40,
      silenceEndMs: 60,
    });

    const events = [
      ...vad.process(pcm(createSilencePcm16(20))),
      ...vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.4))),
      ...vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.4))),
      ...vad.process(pcm(createSilencePcm16(20))),
      ...vad.process(pcm(createSilencePcm16(20))),
      ...vad.process(pcm(createSilencePcm16(20))),
    ];

    expect(events.some((event) => event.type === "speechStart")).toBe(true);
    expect(events.some((event) => event.type === "speechEnd")).toBe(true);
  });

  it("adapts to a quiet microphone and detects speech below the configured threshold", () => {
    const vad = new EnergyVad({
      sampleRate: 16000,
      threshold: 0.018,
      speechStartMs: 40,
      silenceEndMs: 60,
    });

    // Quiet capture: ambient near-silence, then speech at ~0.007 RMS —
    // well below the fixed 0.018 threshold that used to gate detection.
    const events = [
      ...vad.process(pcm(createSilencePcm16(20))),
      ...vad.process(pcm(createSilencePcm16(20))),
      ...vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.01))),
      ...vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.01))),
      ...vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.01))),
    ];

    expect(events.some((event) => event.type === "speechStart")).toBe(true);
  });

  it("never treats digital silence as speech, even in adaptive mode", () => {
    const vad = new EnergyVad({
      sampleRate: 16000,
      threshold: 0.018,
      speechStartMs: 40,
      silenceEndMs: 60,
    });

    const events = Array.from({ length: 50 }, () => vad.process(pcm(createSilencePcm16(20)))).flat();

    expect(events.some((event) => event.type === "speechStart")).toBe(false);
  });

  it("uses a fixed cutoff when adaptive is disabled", () => {
    const vad = new EnergyVad({
      sampleRate: 16000,
      threshold: 0.018,
      speechStartMs: 40,
      silenceEndMs: 60,
      adaptive: false,
    });

    const events = [
      ...vad.process(pcm(createSilencePcm16(20))),
      ...vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.01))),
      ...vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.01))),
      ...vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.01))),
    ];

    expect(events.some((event) => event.type === "speechStart")).toBe(false);
  });

  it("does not absorb a long continuous sentence into the noise floor", () => {
    const vad = new EnergyVad({
      sampleRate: 16000,
      threshold: 0.018,
      speechStartMs: 40,
      silenceEndMs: 900,
    });

    // Quiet room, then 10 s of uninterrupted speech at a quiet-mic level.
    // Before the floor was frozen during speech, the adaptive threshold crept
    // above the speaker's energy after ~5 s and cut the utterance mid-phrase.
    vad.process(pcm(createSilencePcm16(20)));
    vad.process(pcm(createSilencePcm16(20)));

    const events = Array.from({ length: 500 }, () =>
      vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.01)))
    ).flat();

    expect(events.some((event) => event.type === "speechStart")).toBe(true);
    expect(events.some((event) => event.type === "speechEnd")).toBe(false);
    expect(vad.levelStats().effectiveThreshold).toBeLessThan(0.007);
  });

  it("survives a natural mid-sentence pause shorter than silenceEndMs", () => {
    const vad = new EnergyVad({
      sampleRate: 16000,
      threshold: 0.018,
      speechStartMs: 40,
      silenceEndMs: 900,
    });

    const speak = (frames: number) =>
      Array.from({ length: frames }, () =>
        vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.01)))
      ).flat();
    const pause = (frames: number) =>
      Array.from({ length: frames }, () => vad.process(pcm(createSilencePcm16(20)))).flat();

    vad.process(pcm(createSilencePcm16(20)));
    const events = [
      ...speak(25),
      ...pause(30), // 600 ms breathing pause — must NOT end the utterance
      ...speak(25),
      ...pause(50), // 1000 ms of trailing silence — ends it
    ];

    const ends = events.filter((event) => event.type === "speechEnd");
    expect(ends).toHaveLength(1);
    expect(events.indexOf(ends[0])).toBeGreaterThan(events.findIndex((event) => event.type === "speechStart"));
  });

  it("honours a stricter noise-to-speech ratio for barge-in monitoring", () => {
    const makeVad = (noiseToSpeechRatio: number) =>
      new EnergyVad({
        sampleRate: 16000,
        threshold: 0.018,
        speechStartMs: 40,
        silenceEndMs: 60,
        noiseToSpeechRatio,
      });

    // Constant background (TTS speaker bleed) at ~0.004 RMS, voice at ~0.011.
    const feed = (vad: EnergyVad) => {
      const events = [];
      for (let index = 0; index < 10; index += 1) {
        events.push(...vad.process(pcm(createSineWavePcm16(220, 20, PCM16_MONO_16KHZ, 0.0057))));
      }
      for (let index = 0; index < 5; index += 1) {
        events.push(...vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.0156))));
      }
      return events;
    };

    expect(feed(makeVad(2.5)).some((event) => event.type === "speechStart")).toBe(true);
    expect(feed(makeVad(3.5)).some((event) => event.type === "speechStart")).toBe(false);
  });

  it("reports measured input levels for diagnostics", () => {
    const vad = new EnergyVad({ sampleRate: 16000, threshold: 0.018 });

    vad.process(pcm(createSilencePcm16(20)));
    vad.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.4)));

    const stats = vad.levelStats();
    expect(stats.maxEnergy).toBeGreaterThan(0.2);
    expect(stats.configuredThreshold).toBe(0.018);
    expect(stats.effectiveThreshold).toBeGreaterThan(0);

    vad.reset();
    expect(vad.levelStats().maxEnergy).toBe(0);
  });
});

describe("AudioTurnDetector", () => {
  it("groups speech chunks into a completed turn", () => {
    const detector = new AudioTurnDetector({
      sampleRate: 16000,
      threshold: 0.05,
      speechStartMs: 40,
      silenceEndMs: 40,
    });

    const events = [
      ...detector.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.4))),
      ...detector.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.4))),
      ...detector.process(pcm(createSineWavePcm16(440, 20, PCM16_MONO_16KHZ, 0.4))),
      ...detector.process(pcm(createSilencePcm16(20))),
      ...detector.process(pcm(createSilencePcm16(20))),
    ];

    const turnEnd = events.find((event) => event.type === "turnEnd");

    expect(events.some((event) => event.type === "turnStart")).toBe(true);
    expect(turnEnd?.type).toBe("turnEnd");
    expect(turnEnd?.audio.data.length).toBeGreaterThan(0);
  });
});

function pcm(data: Buffer): AudioBuffer {
  return {
    data,
    format: PCM16_MONO_16KHZ,
    container: "pcm",
  };
}
