import { EventEmitter } from "events";
import { ChildProcessWithoutNullStreams } from "child_process";
import { PCM16_MONO_16KHZ, createSilencePcm16 } from "../src/audio/wav";
import { AudioBuffer } from "../src/audio/types";
import { collectFinalTranscript } from "../src/speech/stt/factory";
import { mapWhisperLanguage, parseWhisperTranscript, WhisperCppSTTProvider } from "../src/speech/stt/whisperCpp";
import { TranscriptEvent } from "../src/speech/stt/types";

class FakeProcess extends EventEmitter {
  stdout = makeReadableEmitter();
  stderr = makeReadableEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit("close", null);
    return true;
  }
}

describe("WhisperCppSTTProvider", () => {
  it("parses timestamped whisper.cpp transcript lines", () => {
    const output = `
whisper_init_from_file_with_params_no_state: loading model
[00:00:00.000 --> 00:00:01.200] Bonjour tout le monde.
[00:00:01.200 --> 00:00:02.000] Comment ca va ?
`;

    expect(parseWhisperTranscript(output)).toBe("Bonjour tout le monde. Comment ca va ?");
  });

  it("maps supported voice languages to whisper language flags", () => {
    expect(mapWhisperLanguage("fr")).toBe("fr");
    expect(mapWhisperLanguage("en")).toBe("en");
  });

  it("emits partial, final, and end events for a successful transcription", async () => {
    const fake = new FakeProcess();
    const spawnMock = jest.fn(() => fake as unknown as ChildProcessWithoutNullStreams);
    const provider = new WhisperCppSTTProvider(
      {
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        language: "fr",
        sampleRate: 16000,
      },
      {
        spawn: spawnMock as never,
        fs: makeFsMock(true),
        tmpDir: "C:\\tmp",
      }
    );

    const eventsPromise = collectEvents(provider.transcribe(sampleAudio()));

    setImmediate(() => {
      fake.stdout.emit("data", Buffer.from("[00:00:00.000 --> 00:00:01.000] Bonjour\n"));
      fake.emit("close", 0);
    });

    const events = await eventsPromise;

    expect(spawnMock).toHaveBeenCalledWith("whisper-cli", [
      "-m",
      "model.bin",
      "-f",
      expect.stringContaining("llmtest-stt-"),
      "-l",
      "fr",
      "-nt",
    ]);
    expect(events.map((event) => event.type)).toEqual(["partial", "final", "end"]);
    expect(events.find((event) => event.type === "final")).toMatchObject({
      text: "Bonjour",
    });
  });

  it("uses the configured language override when transcribing", async () => {
    const fake = new FakeProcess();
    const spawnMock = jest.fn(() => fake as unknown as ChildProcessWithoutNullStreams);
    const provider = new WhisperCppSTTProvider(
      {
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        language: "fr",
        sampleRate: 16000,
      },
      {
        spawn: spawnMock as never,
        fs: makeFsMock(true),
      }
    );

    const transcriptPromise = collectFinalTranscript(provider.transcribe(sampleAudio(), { language: "en" }));

    setImmediate(() => {
      fake.stdout.emit("data", Buffer.from("Hello there\n"));
      fake.emit("close", 0);
    });

    await expect(transcriptPromise).resolves.toBe("Hello there");
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain("en");
  });

  it("surfaces a missing model as an error event", async () => {
    const provider = new WhisperCppSTTProvider(
      {
        binaryPath: "whisper-cli",
        modelPath: "missing.bin",
        language: "fr",
        sampleRate: 16000,
      },
      {
        spawn: jest.fn() as never,
        fs: makeFsMock(false),
      }
    );

    await expect(collectFinalTranscript(provider.transcribe(sampleAudio()))).rejects.toThrow(
      "Whisper model not found"
    );
  });

  it("surfaces failed whisper.cpp exits as actionable errors", async () => {
    const fake = new FakeProcess();
    const provider = new WhisperCppSTTProvider(
      {
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        language: "fr",
        sampleRate: 16000,
      },
      {
        spawn: jest.fn(() => fake as unknown as ChildProcessWithoutNullStreams) as never,
        fs: makeFsMock(true),
      }
    );

    const transcriptPromise = collectFinalTranscript(provider.transcribe(sampleAudio()));

    setImmediate(() => {
      fake.stderr.emit("data", Buffer.from("failed to load model\n"));
      fake.emit("close", 2);
    });

    await expect(transcriptPromise).rejects.toThrow("whisper.cpp exited with code 2");
  });

  it("checks setup without requiring a real binary in tests", async () => {
    const fake = new FakeProcess();
    const provider = new WhisperCppSTTProvider(
      {
        binaryPath: "whisper-cli",
        modelPath: "model.bin",
        language: "fr",
        sampleRate: 16000,
      },
      {
        spawn: jest.fn(() => fake as unknown as ChildProcessWithoutNullStreams) as never,
        fs: makeFsMock(true),
      }
    );

    const setupPromise = provider.checkSetup();
    setImmediate(() => fake.emit("close", 0));

    await expect(setupPromise).resolves.toMatchObject({
      ok: true,
    });
  });
});

function sampleAudio(): AudioBuffer {
  return {
    data: createSilencePcm16(100, PCM16_MONO_16KHZ),
    format: PCM16_MONO_16KHZ,
    container: "pcm",
  };
}

function makeFsMock(exists: boolean) {
  return {
    existsSync: jest.fn(() => exists),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
  };
}

function makeReadableEmitter(): NodeJS.ReadableStream {
  const stream = new EventEmitter() as NodeJS.ReadableStream;
  stream.resume = jest.fn(() => stream);
  return stream;
}

async function collectEvents(events: AsyncIterable<TranscriptEvent>): Promise<TranscriptEvent[]> {
  const collected: TranscriptEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
