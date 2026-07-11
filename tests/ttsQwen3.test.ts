import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CancellablePlaybackQueue } from "../src/audio/player";
import { AudioBuffer, AudioOutput, PlaybackResult } from "../src/audio/types";
import { PCM16_MONO_16KHZ, createToneWav } from "../src/audio/wav";
import {
  chunkTextForTTS,
  collectTTSAudioEvents,
  loadVoiceDesignPrompt,
  synthesizeTextToPlayback,
} from "../src/speech/tts/factory";
import { ITTSProvider } from "../src/speech/tts/ITTSProvider";
import { mapQwenTTSLanguage, Qwen3TTSProvider } from "../src/speech/tts/qwen3Tts";
import { TTSAudioResult, TTSEvent, TTSSynthesisOptions, TTSSetupCheck } from "../src/speech/tts/types";

describe("Qwen3TTSProvider", () => {
  it("maps supported voice languages to Qwen language names", () => {
    expect(mapQwenTTSLanguage("fr")).toBe("French");
    expect(mapQwenTTSLanguage("en")).toBe("English");
  });

  it("checks setup through the local service health endpoint", async () => {
    const fetchMock = jest.fn(async () => new Response("ok", { status: 200 })) as unknown as jest.MockedFunction<typeof fetch>;
    const provider = makeProvider(fetchMock);

    await expect(provider.checkSetup()).resolves.toMatchObject({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:7861/health", expect.objectContaining({
      method: "GET",
    }));
  });

  it("synthesizes WAV audio and sends voice design instructions", async () => {
    const wav = createToneWav(440, 100, PCM16_MONO_16KHZ).data;
    const fetchMock = jest.fn(async () => new Response(new Uint8Array(wav), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const provider = makeProvider(fetchMock);

    const result = await provider.synthesize("Bonjour.", {
      language: "fr",
      voiceDesignPrompt: "Warm and precise.",
    });

    expect(result.audio.container).toBe("wav");
    expect(result.audio.data.equals(wav)).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
      input: "Bonjour.",
      language: "French",
      instruct: "Warm and precise.",
      instructions: "Warm and precise.",
    });
  });

  it("accepts JSON base64 audio responses", async () => {
    const wav = createToneWav(440, 100, PCM16_MONO_16KHZ).data;
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      audio_base64: wav.toString("base64"),
      sample_rate: 16000,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const provider = makeProvider(fetchMock);

    const result = await provider.synthesize("Hello.");

    expect(result.audio.container).toBe("wav");
    expect(result.bytes).toBe(wav.length);
  });

  it("falls back to /synthesize when the OpenAI-compatible endpoint is absent", async () => {
    const wav = createToneWav(440, 100, PCM16_MONO_16KHZ).data;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(wav), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      })) as unknown as jest.MockedFunction<typeof fetch>;
    const provider = makeProvider(fetchMock);

    await expect(provider.synthesize("Hello.")).resolves.toMatchObject({
      bytes: wav.length,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:7861/v1/audio/speech");
    expect(fetchMock.mock.calls[1][0]).toBe("http://localhost:7861/synthesize");
  });

  it("surfaces backend errors with response details", async () => {
    const fetchMock = jest.fn(async () => new Response("model not loaded", {
      status: 503,
      statusText: "Service Unavailable",
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const provider = makeProvider(fetchMock);

    await expect(provider.synthesize("Hello.")).rejects.toThrow("model not loaded");
  });

  it("times out slow synthesis requests", async () => {
    const fetchMock = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const provider = makeProvider(fetchMock, 10);

    await expect(provider.synthesize("Hello.")).rejects.toThrow("timed out");
  });

  it("honors cancellation before sending a request", async () => {
    const fetchMock = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
    const provider = makeProvider(fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(provider.synthesize("Hello.", { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits audio and end events for chunked synthesis", async () => {
    const wav = createToneWav(440, 100, PCM16_MONO_16KHZ).data;
    const fetchMock = jest.fn(async () => new Response(new Uint8Array(wav), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    })) as unknown as jest.MockedFunction<typeof fetch>;
    const provider = makeProvider(fetchMock);

    const events = await collectTTSAudioEvents(provider.synthesizeChunks(["Hello.", "Again."]));

    expect(events.map((event) => event.type)).toEqual(["audio", "audio", "end"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("TTS helpers", () => {
  it("chunks long responses on sentence boundaries", () => {
    const chunks = chunkTextForTTS(
      "First short sentence. Second short sentence. Third sentence with enough content to stand alone.",
      { maxChars: 45, minChars: 20 }
    );

    expect(chunks).toEqual([
      "First short sentence. Second short sentence.",
      "Third sentence with enough content to stand",
      "alone.",
    ]);
  });

  it("loads the editable voice-style prompt", () => {
    const promptsDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmtest-prompts-"));
    fs.writeFileSync(path.join(promptsDir, "voice-style.md"), "Measured and friendly.");

    const prompt = loadVoiceDesignPrompt({
      language: "en",
      sttProvider: "whisper-cpp",
      sttBinaryPath: "whisper-cli",
      sttModelPath: "model.bin",
      sttBaseUrl: "http://localhost:7862",
      sttTimeoutMs: 60000,
      ttsProvider: "qwen3-tts",
      ttsBaseUrl: "http://localhost:7861",
      ttsModel: "model",
      ttsTimeoutMs: 120000,
      sampleRate: 16000,
      bargeIn: true,
      debugTranscript: true,
      promptsDir,
      vadThreshold: 0.018,
      vadSpeechMs: 120,
      vadSilenceMs: 500,
      vadMinThreshold: 0.002,
      bargeInSpeechMs: 250,
    });

    expect(prompt).toBe("Measured and friendly.");
    fs.rmSync(promptsDir, { recursive: true, force: true });
  });

  it("queues synthesized chunks into cancellable playback", async () => {
    const provider = new MockTTSProvider();
    const output = new InterruptibleOutput();
    const queue = new CancellablePlaybackQueue(output);

    const resultPromise = synthesizeTextToPlayback(
      provider,
      queue,
      `${"One ".repeat(80)}. ${"Two ".repeat(80)}.`,
      {
      language: "en",
      voiceDesignPrompt: "Friendly.",
      }
    );
    await delay(20);
    const stoppedInMs = await queue.stop();
    const result = await resultPromise;

    expect(stoppedInMs).toBeLessThan(200);
    expect(result.queued).toBeGreaterThan(1);
    expect(result.interrupted).toBeGreaterThan(1);
    expect(output.stopped).toBe(1);
  });
});

function makeProvider(fetchMock: jest.MockedFunction<typeof fetch>, timeoutMs = 1000): Qwen3TTSProvider {
  return new Qwen3TTSProvider(
    {
      baseUrl: "http://localhost:7861",
      model: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
      language: "fr",
      sampleRate: 16000,
      timeoutMs,
    },
    {
      fetch: fetchMock,
      now: Date.now,
    }
  );
}

class MockTTSProvider implements ITTSProvider {
  readonly name = "mock-tts";

  async checkSetup(): Promise<TTSSetupCheck> {
    return { ok: true, details: "ok" };
  }

  async synthesize(text: string, _options?: TTSSynthesisOptions): Promise<TTSAudioResult> {
    const audio = createToneWav(text.startsWith("One") ? 440 : 550, 100, PCM16_MONO_16KHZ);
    return {
      audio,
      latencyMs: 1,
      bytes: audio.data.length,
    };
  }

  async *synthesizeChunks(chunks: AsyncIterable<string> | Iterable<string>, options?: TTSSynthesisOptions): AsyncIterable<TTSEvent> {
    let chunkIndex = 0;
    for await (const chunk of chunks) {
      const result = await this.synthesize(chunk, options);
      yield {
        type: "audio",
        audio: result.audio,
        text: chunk,
        chunkIndex,
        timestampMs: chunkIndex,
      };
      chunkIndex += 1;
    }
    yield { type: "end", timestampMs: chunkIndex };
  }
}

class InterruptibleOutput implements AudioOutput {
  stopped = 0;

  async play(_audio: AudioBuffer, signal?: AbortSignal): Promise<PlaybackResult> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          completed: true,
          interrupted: false,
          durationMs: Date.now() - startedAt,
        });
      }, 50);

      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve({
          completed: false,
          interrupted: true,
          durationMs: Date.now() - startedAt,
        });
      }, { once: true });
    });
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
