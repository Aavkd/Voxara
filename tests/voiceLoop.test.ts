import { CancellablePlaybackQueue } from "../src/audio/player";
import { AudioBuffer, AudioOutput, PlaybackResult } from "../src/audio/types";
import { PCM16_MONO_16KHZ, createToneWav } from "../src/audio/wav";
import {
  startVoiceAgentAssistantTurn,
  startVoiceAssistantTurn,
  StreamingTextChunker,
} from "../src/commands/voiceChat";
import { ILLMProvider } from "../src/providers/ILLMProvider";
import { IToolProvider } from "../src/providers/tools/IToolProvider";
import { ITTSProvider } from "../src/speech/tts/ITTSProvider";
import { TTSAudioResult, TTSEvent, TTSSynthesisOptions, TTSSetupCheck } from "../src/speech/tts/types";
import {
  AgentStepResult,
  ChatResult,
  Message,
  PromptInput,
  PromptResult,
  Session,
  ValidationResult,
  VoiceConfig,
} from "../src/types";

describe("StreamingTextChunker", () => {
  it("emits sentence-sized chunks before the full response is closed", async () => {
    const chunker = new StreamingTextChunker({ minChars: 20, maxChars: 120 });
    const iterator = chunker[Symbol.asyncIterator]();
    const next = iterator.next();

    chunker.push("This is enough text to speak quickly. More text is still arriving");

    await expect(next).resolves.toEqual({
      value: "This is enough text to speak quickly.",
      done: false,
    });

    chunker.close();
    await expect(iterator.next()).resolves.toEqual({
      value: "More text is still arriving",
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });
});

describe("voice assistant turn", () => {
  it("streams LLM chunks into TTS before the full model response completes", async () => {
    const provider = new MockLLMProvider([
      "Bonjour, je commence a repondre avec assez de texte pour lancer la voix. ",
      "Voici la fin de la reponse.",
    ]);
    const tts = new MockTTSProvider();
    const output = new MockAudioOutput(5);
    const playback = new CancellablePlaybackQueue(output);
    const session = makeSession();

    const turn = startVoiceAssistantTurn({
      provider,
      ttsProvider: tts,
      playback,
      session,
      userTranscript: "Bonjour",
      voice: makeVoiceConfig("fr"),
      voiceDesignPrompt: "Warm.",
      turnIndex: 1,
      saveSession: jest.fn(),
    });

    await waitFor(() => tts.chunks.length > 0);
    expect(provider.completed).toBe(false);

    const result = await turn.done;

    expect(result.interrupted).toBe(false);
    expect(tts.chunks.length).toBeGreaterThan(0);
    expect(output.played).toBeGreaterThan(0);
    expect(session.messages.at(-1)?.role).toBe("model");
  });

  it("stops playback and marks the assistant turn when interrupted", async () => {
    const provider = new MockLLMProvider([
      "This answer has enough text to start speech before it is interrupted. ",
      "This later text should not be queued after interruption.",
    ], 25);
    const tts = new MockTTSProvider();
    const output = new MockAudioOutput(100);
    const playback = new CancellablePlaybackQueue(output);
    const session = makeSession();

    const turn = startVoiceAssistantTurn({
      provider,
      ttsProvider: tts,
      playback,
      session,
      userTranscript: "Please explain",
      voice: makeVoiceConfig("en"),
      voiceDesignPrompt: "Clear.",
      turnIndex: 1,
      saveSession: jest.fn(),
    });

    await waitFor(() => tts.chunks.length > 0);
    await turn.interrupt("test");
    const result = await turn.done;

    expect(result.interrupted).toBe(true);
    expect(result.metrics.playbackStopMs).toBeLessThan(200);
    expect(output.stopped).toBe(1);
    expect(session.messages.at(-1)?.content).toContain("[interrupted]");
  });

  it("settles promptly on interrupt even when the LLM stream is still open", async () => {
    const provider = new HangingLLMProvider(
      "This first chunk is long enough to trigger text to speech synthesis right away. "
    );
    const tts = new MockTTSProvider();
    const output = new MockAudioOutput(5);
    const playback = new CancellablePlaybackQueue(output);
    const session = makeSession();

    const turn = startVoiceAssistantTurn({
      provider,
      ttsProvider: tts,
      playback,
      session,
      userTranscript: "Tell me something long",
      voice: makeVoiceConfig("en"),
      voiceDesignPrompt: "Clear.",
      turnIndex: 1,
      saveSession: jest.fn(),
    });

    await waitFor(() => tts.chunks.length > 0);
    const interruptedAt = Date.now();
    await turn.interrupt("barge-in");
    const result = await turn.done;

    // Without LLM cancellation the turn only settles after the provider's
    // 5-second hang, which stalls the next listening turn after a barge-in.
    expect(Date.now() - interruptedAt).toBeLessThan(1000);
    expect(provider.sawAbort).toBe(true);
    expect(result.interrupted).toBe(true);
  });

  it("does not leak an unhandled rejection when TTS aborts while the LLM stream is open", async () => {
    // Regression: a barge-in that aborts mid-synthesis rejects ttsPromise
    // before done() reaches its await (it is still on streamChat). Without a
    // pre-attached handler that rejection is unhandled and crashed the process
    // (yoga-layout's nbind rethrows unhandled rejections).
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const provider = new SignalIgnoringLLMProvider(
        "This first chunk is long enough to trigger text to speech synthesis right away. ",
        250
      );
      const tts = new AbortThrowingTTSProvider();
      const output = new MockAudioOutput(5);
      const playback = new CancellablePlaybackQueue(output);
      const session = makeSession();

      const turn = startVoiceAssistantTurn({
        provider,
        ttsProvider: tts,
        playback,
        session,
        userTranscript: "Tell me something",
        voice: makeVoiceConfig("fr"),
        voiceDesignPrompt: "Warm.",
        turnIndex: 1,
        saveSession: jest.fn(),
      });

      await waitFor(() => tts.synthesizing);
      await turn.interrupt("barge-in");
      const result = await turn.done;

      // Give the event loop a beat: unhandledRejection fires asynchronously.
      await delay(30);

      expect(result.interrupted).toBe(true);
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("runs tools in agent mode and speaks only the final answer", async () => {
    const provider = new MockAgentLLMProvider([
      {
        type: "tool_call",
        toolName: "calculator",
        toolParams: { expression: "2 + 3" },
        inputTokens: 3,
        outputTokens: 2,
      },
      {
        type: "final_answer",
        text: "The result is 5.",
        inputTokens: 4,
        outputTokens: 5,
      },
    ]);
    const tool = new MockToolProvider("calculator", "5");
    const tts = new MockTTSProvider();
    const output = new MockAudioOutput(5);
    const playback = new CancellablePlaybackQueue(output);
    const session = makeSession();
    const steps: AgentStepResult[] = [];

    const turn = startVoiceAgentAssistantTurn({
      provider,
      tools: [tool],
      sandboxDir: process.cwd(),
      maxSteps: 5,
      ttsProvider: tts,
      playback,
      session,
      userTranscript: "What is two plus three?",
      voice: makeVoiceConfig("en"),
      voiceDesignPrompt: "Clear.",
      turnIndex: 1,
      saveSession: jest.fn(),
      onAgentStep: (step) => steps.push(step),
    });

    const result = await turn.done;

    expect(result.interrupted).toBe(false);
    expect(result.text).toBe("The result is 5.");
    expect(result.steps).toBe(2);
    expect(result.toolCallsMade).toHaveLength(1);
    expect(tool.calls).toEqual([{ expression: "2 + 3" }]);
    expect(tts.chunks).toEqual(["The result is 5."]);
    expect(output.played).toBeGreaterThan(0);
    expect(session.messages.at(-1)?.content).toBe("The result is 5.");
    expect(steps.map((step) => step.type)).toEqual(["tool_call", "final_answer"]);
  });
});

class MockLLMProvider implements ILLMProvider {
  readonly name = "mock-llm";
  completed = false;

  constructor(
    private readonly chunks: string[],
    private readonly delayMs = 5
  ) {}

  async validate(): Promise<ValidationResult> {
    return { valid: true };
  }

  async prompt(_input: PromptInput): Promise<PromptResult> {
    throw new Error("not implemented");
  }

  async chat(_messages: Message[]): Promise<ChatResult> {
    throw new Error("not implemented");
  }

  async streamChat(_messages: Message[], onChunk: (chunk: string) => void): Promise<ChatResult> {
    let text = "";

    for (const chunk of this.chunks) {
      await delay(this.delayMs);
      text += chunk;
      onChunk(chunk);
    }

    this.completed = true;
    return {
      message: {
        role: "model",
        content: text,
        timestamp: Date.now(),
      },
      latencyMs: this.delayMs * this.chunks.length,
      inputTokens: 1,
      outputTokens: 2,
    };
  }
}

/** Emits one chunk, then keeps the stream open until aborted (or 5 s). */
class HangingLLMProvider implements ILLMProvider {
  readonly name = "hanging-llm";
  sawAbort = false;

  constructor(private readonly firstChunk: string) {}

  async validate(): Promise<ValidationResult> {
    return { valid: true };
  }

  async prompt(_input: PromptInput): Promise<PromptResult> {
    throw new Error("not implemented");
  }

  async chat(_messages: Message[]): Promise<ChatResult> {
    throw new Error("not implemented");
  }

  async streamChat(
    _messages: Message[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    onChunk(this.firstChunk);

    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        this.sawAbort = true;
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 5000);
      signal?.addEventListener("abort", () => {
        this.sawAbort = true;
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });

    return {
      message: { role: "model", content: this.firstChunk, timestamp: Date.now() },
      latencyMs: 1,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

/** Ignores the abort signal entirely and keeps streaming for a fixed time. */
class SignalIgnoringLLMProvider implements ILLMProvider {
  readonly name = "signal-ignoring-llm";

  constructor(
    private readonly firstChunk: string,
    private readonly hangMs: number
  ) {}

  async validate(): Promise<ValidationResult> {
    return { valid: true };
  }

  async prompt(_input: PromptInput): Promise<PromptResult> {
    throw new Error("not implemented");
  }

  async chat(_messages: Message[]): Promise<ChatResult> {
    throw new Error("not implemented");
  }

  async streamChat(_messages: Message[], onChunk: (chunk: string) => void): Promise<ChatResult> {
    onChunk(this.firstChunk);
    await delay(this.hangMs);
    return {
      message: { role: "model", content: this.firstChunk, timestamp: Date.now() },
      latencyMs: this.hangMs,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

/** Mirrors the real providers: an abort mid-synthesis surfaces as a thrown error. */
class AbortThrowingTTSProvider implements ITTSProvider {
  readonly name = "abort-throwing-tts";
  synthesizing = false;

  async checkSetup(): Promise<TTSSetupCheck> {
    return { ok: true, details: "ok" };
  }

  async synthesize(_text: string, _options?: TTSSynthesisOptions): Promise<TTSAudioResult> {
    throw new Error("not implemented");
  }

  async *synthesizeChunks(
    chunks: AsyncIterable<string> | Iterable<string>,
    options?: TTSSynthesisOptions
  ): AsyncIterable<TTSEvent> {
    for await (const _chunk of chunks) {
      this.synthesizing = true;
      await new Promise<void>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("synthesis never aborted")), 2000);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("TTS synthesis was cancelled."));
        }, { once: true });
      });
    }
  }
}

class MockTTSProvider implements ITTSProvider {
  readonly name = "mock-tts";
  readonly chunks: string[] = [];

  async checkSetup(): Promise<TTSSetupCheck> {
    return { ok: true, details: "ok" };
  }

  async synthesize(text: string, _options?: TTSSynthesisOptions): Promise<TTSAudioResult> {
    const audio = createToneWav(text.length > 40 ? 440 : 520, 25, PCM16_MONO_16KHZ);
    return {
      audio,
      latencyMs: 1,
      bytes: audio.data.length,
    };
  }

  async *synthesizeChunks(
    chunks: AsyncIterable<string> | Iterable<string>,
    options?: TTSSynthesisOptions
  ): AsyncIterable<TTSEvent> {
    let chunkIndex = 0;
    for await (const chunk of chunks) {
      if (options?.signal?.aborted) {
        break;
      }
      this.chunks.push(chunk);
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

class MockAgentLLMProvider implements ILLMProvider {
  readonly name = "mock-agent-llm";
  private index = 0;

  constructor(private readonly steps: AgentStepResult[]) {}

  async validate(): Promise<ValidationResult> {
    return { valid: true };
  }

  async prompt(_input: PromptInput): Promise<PromptResult> {
    throw new Error("not implemented");
  }

  async chat(_messages: Message[]): Promise<ChatResult> {
    throw new Error("not implemented");
  }

  async streamChat(_messages: Message[], _onChunk: (chunk: string) => void): Promise<ChatResult> {
    throw new Error("not implemented");
  }

  async promptWithTools(_messages: Message[], _tools: IToolProvider[]): Promise<AgentStepResult> {
    const next = this.steps[this.index];
    this.index += 1;
    if (!next) {
      return {
        type: "final_answer",
        text: "done",
        inputTokens: 0,
        outputTokens: 0,
      };
    }
    return next;
  }
}

class MockToolProvider implements IToolProvider {
  readonly description = "Mock tool";
  readonly parameters = {
    type: "object",
    properties: {
      expression: { type: "string" },
    },
  };
  readonly calls: Record<string, unknown>[] = [];

  constructor(
    readonly name: string,
    private readonly result: unknown
  ) {}

  async execute(params: Record<string, unknown>, _sandboxDir: string): Promise<unknown> {
    this.calls.push(params);
    return this.result;
  }
}

class MockAudioOutput implements AudioOutput {
  played = 0;
  stopped = 0;

  constructor(private readonly playbackMs: number) {}

  async play(_audio: AudioBuffer, signal?: AbortSignal): Promise<PlaybackResult> {
    this.played += 1;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          completed: true,
          interrupted: false,
          durationMs: Date.now() - startedAt,
        });
      }, this.playbackMs);

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

function makeSession(): Session {
  return {
    id: "voice-test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: "mock",
    messages: [],
  };
}

function makeVoiceConfig(language: "fr" | "en"): VoiceConfig {
  return {
    language,
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
    promptsDir: "./prompts",
    vadThreshold: 0.018,
    vadSpeechMs: 120,
    vadSilenceMs: 500,
    vadMinThreshold: 0.002,
    bargeInSpeechMs: 250,
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for condition.");
    }
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
