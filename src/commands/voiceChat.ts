import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../config/loader";
import { runAgentLoop } from "../engine/agentLoop";
import { createProvider } from "../providers/factory";
import { ILLMProvider } from "../providers/ILLMProvider";
import { getAllToolNames, getAllTools, getTools } from "../providers/tools/index";
import { IToolProvider } from "../providers/tools/IToolProvider";
import { FfmpegMicrophoneCapture } from "../audio/microphone";
import { CancellablePlaybackQueue, SystemAudioOutput } from "../audio/player";
import { MicrophoneCapture } from "../audio/types";
import { SILENT_CAPTURE_RMS } from "../audio/vad";
import { VoiceConversationState } from "../audio/conversationState";
import { InterruptController } from "../audio/interruptController";
import { renderPrompt, validatePrompts } from "../prompts/promptLoader";
import {
  appendVoiceTranscriptEvent,
  createSession,
  createVoiceTranscriptLog,
  saveSession,
} from "../session/session";
import { collectFinalTranscript, createSTTProvider } from "../speech/stt/factory";
import { ISTTProvider } from "../speech/stt/ISTTProvider";
import { TranscriptEvent } from "../speech/stt/types";
import { createTTSProvider, loadVoiceDesignPrompt } from "../speech/tts/factory";
import { ITTSProvider } from "../speech/tts/ITTSProvider";
import {
  AgentStepResult,
  AppConfig,
  ChatResult,
  Message,
  Session,
  ToolCallRecord,
  VoiceConfig,
  VoiceTranscriptLog,
} from "../types";

interface VoiceChatOptions {
  key?: string;
  model?: string;
  device?: string;
  listenWindow?: string;
  agent?: boolean;
  tools?: string;
  sandbox?: string;
  agentMaxSteps?: string;
}

interface VoiceAssistantTurnOptions {
  provider: ILLMProvider;
  ttsProvider: ITTSProvider;
  playback: CancellablePlaybackQueue;
  interruptController?: InterruptController;
  session: Session;
  userTranscript: string;
  voice: VoiceConfig;
  voiceDesignPrompt: string;
  log?: VoiceTranscriptLog;
  turnIndex: number;
  now?: () => number;
  saveSession?: (session: Session) => void;
}

interface VoiceAgentAssistantTurnOptions extends Omit<VoiceAssistantTurnOptions, "provider"> {
  provider: ILLMProvider;
  tools: IToolProvider[];
  sandboxDir: string;
  maxSteps: number;
  onAgentStep?: (step: AgentStepResult) => void;
  onToolResult?: (toolCall: ToolCallRecord) => void;
}

export interface VoiceAssistantTurnResult {
  text: string;
  interrupted: boolean;
  metrics: {
    llmFirstTokenMs?: number;
    ttsFirstAudioMs?: number;
    ttsChunkMs: number[];
    playbackStopMs?: number;
    endToEndMs: number;
  };
  inputTokens: number;
  outputTokens: number;
  steps?: number;
  toolCallsMade?: ToolCallRecord[];
}

export interface VoiceAssistantTurn {
  done: Promise<VoiceAssistantTurnResult>;
  interrupt(reason?: string, stoppedInMs?: number): Promise<void>;
  isInterrupted(): boolean;
  isSettled(): boolean;
}

interface PendingQueueItem<T> {
  value?: T;
  done?: boolean;
  error?: Error;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: PendingQueueItem<T>[] = [];
  private readonly waiters: Array<(item: PendingQueueItem<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value });
      return;
    }
    this.items.push({ value });
  }

  fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resolveNext({ error });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resolveNext({ done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.items.shift() || await new Promise<PendingQueueItem<T>>((resolve) => {
        this.waiters.push(resolve);
      });

      if (item.error) {
        throw item.error;
      }
      if (item.done) {
        return;
      }
      if (item.value !== undefined) {
        yield item.value;
      }
    }
  }

  private resolveNext(item: PendingQueueItem<T>): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }
}

export class StreamingTextChunker implements AsyncIterable<string> {
  private readonly queue = new AsyncQueue<string>();
  private readonly minChars: number;
  private readonly maxChars: number;
  private buffer = "";
  private closed = false;

  constructor(options: { minChars?: number; maxChars?: number } = {}) {
    this.minChars = options.minChars ?? 40;
    this.maxChars = options.maxChars ?? 260;
  }

  push(text: string): void {
    if (this.closed || !text) {
      return;
    }

    this.buffer += text;
    this.flushReady(false);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.flushReady(true);
    this.closed = true;
    this.queue.close();
  }

  fail(error: Error): void {
    this.closed = true;
    this.queue.fail(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return this.queue[Symbol.asyncIterator]();
  }

  private flushReady(force: boolean): void {
    while (this.buffer.trim().length > 0) {
      const normalized = this.buffer.replace(/\s+/g, " ");
      const boundary = findChunkBoundary(normalized, this.minChars, this.maxChars, force);

      if (boundary <= 0) {
        this.buffer = normalized;
        return;
      }

      const chunk = normalized.slice(0, boundary).trim();
      this.buffer = normalized.slice(boundary).trimStart();
      if (chunk) {
        this.queue.push(chunk);
      }

      if (!force && this.buffer.length < this.minChars) {
        return;
      }
    }
  }
}

export function startVoiceAssistantTurn(options: VoiceAssistantTurnOptions): VoiceAssistantTurn {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const chunker = new StreamingTextChunker({ minChars: options.voice.ttsChunkMinChars, maxChars: options.voice.ttsChunkMaxChars });
  const ttsController = new AbortController();
  const llmController = new AbortController();
  const playbackPromises: Array<Promise<unknown>> = [];
  let interrupted = false;
  let settled = false;
  let partialAssistantText = "";
  let llmFirstTokenMs: number | undefined;
  let ttsFirstAudioMs: number | undefined;
  const ttsChunkMs: number[] = [];
  let playbackStopMs: number | undefined;

  const userMessage: Message = {
    role: "user",
    content: buildVoiceUserMessage(options.userTranscript, options.voice),
    timestamp: now(),
  };
  options.session.messages.push(userMessage);

  const interrupt = async (reason = "manual", stoppedInMs?: number): Promise<void> => {
    if (interrupted) {
      return;
    }

    interrupted = true;
    playbackStopMs = stoppedInMs ?? 0;
    chunker.close();
    llmController.abort();
    ttsController.abort();
    playbackStopMs = stoppedInMs ?? await (
      options.interruptController
        ? options.interruptController.interrupt(reason)
        : options.playback.stop()
    );
    options.playback.flush();
    appendVoiceLog(options.log, {
      turnIndex: options.turnIndex,
      type: "interrupted",
      data: { reason, playbackStopMs },
    });
  };

  const ttsPromise = (async () => {
    for await (const event of options.ttsProvider.synthesizeChunks(chunker, {
      language: options.voice.language,
      voiceDesignPrompt: options.voiceDesignPrompt,
      signal: ttsController.signal,
    })) {
      if (event.type === "audio") {
        ttsChunkMs.push(event.latencyMs ?? event.timestampMs);
        if (ttsFirstAudioMs === undefined) {
          ttsFirstAudioMs = now() - startedAt;
        }
        playbackPromises.push(options.playback.play(event.audio).catch((err) => err));
      } else if (event.type === "error") {
        throw event.error;
      }
    }

    await Promise.all(playbackPromises);
  })();
  // done() consumes this rejection at its own `await ttsPromise`, which it only
  // reaches after streamChat settles. A barge-in that aborts mid-synthesis
  // rejects ttsPromise before that point; without a pre-attached handler the
  // rejection is "unhandled" and yoga-layout's nbind global handler escalates
  // it into a process crash.
  ttsPromise.catch(() => undefined);

  const done = (async (): Promise<VoiceAssistantTurnResult> => {
    let streamResult: ChatResult | undefined;
    try {
      streamResult = await options.provider.streamChat(options.session.messages, (chunk) => {
        if (interrupted) {
          return;
        }
        if (llmFirstTokenMs === undefined) {
          llmFirstTokenMs = now() - startedAt;
        }
        partialAssistantText += chunk;
        chunker.push(chunk);
        appendVoiceLog(options.log, {
          turnIndex: options.turnIndex,
          type: "assistant_chunk",
          text: chunk,
        });
      }, llmController.signal);
    } catch (err) {
      // A provider may still reject on abort; after an interrupt the partial
      // text is the answer, so only propagate genuine stream failures.
      if (!interrupted) {
        throw err;
      }
    } finally {
      chunker.close();
    }

    try {
      await ttsPromise;
    } catch (err) {
      if (!interrupted) {
        throw err;
      }
    }

    const assistantText = interrupted
      ? `${partialAssistantText.trim()}\n[interrupted]`.trim()
      : streamResult?.message.content || partialAssistantText;

    const assistantMessage: Message = {
      role: "model",
      content: assistantText,
      timestamp: now(),
    };
    options.session.messages.push(assistantMessage);
    (options.saveSession || saveSession)(options.session);

    const metrics = {
      llmFirstTokenMs,
      ttsFirstAudioMs,
      ttsChunkMs,
      playbackStopMs,
      endToEndMs: now() - startedAt,
    };
    appendVoiceLog(options.log, {
      turnIndex: options.turnIndex,
      type: "assistant_final",
      text: assistantText,
      data: { interrupted },
    });
    appendVoiceLog(options.log, {
      turnIndex: options.turnIndex,
      type: "metrics",
      data: metrics,
    });

    settled = true;
    return {
      text: assistantText,
      interrupted,
      metrics,
      inputTokens: streamResult?.inputTokens ?? 0,
      outputTokens: streamResult?.outputTokens ?? 0,
    };
  })().finally(() => {
    settled = true;
  });

  return {
    done,
    interrupt,
    isInterrupted: () => interrupted,
    isSettled: () => settled,
  };
}

export function startVoiceAgentAssistantTurn(options: VoiceAgentAssistantTurnOptions): VoiceAssistantTurn {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const chunker = new StreamingTextChunker({ minChars: options.voice.ttsChunkMinChars, maxChars: options.voice.ttsChunkMaxChars });
  const ttsController = new AbortController();
  const playbackPromises: Array<Promise<unknown>> = [];
  let interrupted = false;
  let settled = false;
  let assistantText = "";
  let ttsFirstAudioMs: number | undefined;
  const ttsChunkMs: number[] = [];
  let playbackStopMs: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  const agentPrompt = buildVoiceAgentPrompt(options.userTranscript, options.voice);
  const userMessage: Message = {
    role: "user",
    content: agentPrompt,
    timestamp: now(),
  };
  options.session.messages.push(userMessage);

  const interrupt = async (reason = "manual", stoppedInMs?: number): Promise<void> => {
    if (interrupted) {
      return;
    }

    interrupted = true;
    chunker.close();
    ttsController.abort();
    playbackStopMs = stoppedInMs ?? await (
      options.interruptController
        ? options.interruptController.interrupt(reason)
        : options.playback.stop()
    );
    options.playback.flush();
    appendVoiceLog(options.log, {
      turnIndex: options.turnIndex,
      type: "interrupted",
      data: { reason, playbackStopMs, mode: "agent" },
    });
  };

  const ttsPromise = (async () => {
    for await (const event of options.ttsProvider.synthesizeChunks(chunker, {
      language: options.voice.language,
      voiceDesignPrompt: options.voiceDesignPrompt,
      signal: ttsController.signal,
    })) {
      if (event.type === "audio") {
        ttsChunkMs.push(event.latencyMs ?? event.timestampMs);
        if (ttsFirstAudioMs === undefined) {
          ttsFirstAudioMs = now() - startedAt;
        }
        playbackPromises.push(options.playback.play(event.audio).catch((err) => err));
      } else if (event.type === "error") {
        throw event.error;
      }
    }

    await Promise.all(playbackPromises);
  })();
  // Same pre-attached handler as the plain turn: an abort can reject this
  // promise before done() reaches its `await ttsPromise`, and an unhandled
  // rejection crashes the process via yoga-layout's nbind global handler.
  ttsPromise.catch(() => undefined);

  const done = (async (): Promise<VoiceAssistantTurnResult> => {
    let steps = 0;
    let toolCallsMade: ToolCallRecord[] = [];

    try {
      const loopResult = await runAgentLoop(
        options.provider,
        options.tools,
        agentPrompt,
        options.sandboxDir,
        options.maxSteps,
        (step) => {
          steps += 1;
          inputTokens += step.inputTokens;
          outputTokens += step.outputTokens;
          appendVoiceLog(options.log, {
            turnIndex: options.turnIndex,
            type: "tool_activity",
            text: formatAgentStepForLog(step),
            data: { step, mode: "agent" },
          });
          options.onAgentStep?.(step);
        },
        (toolCall) => {
          toolCallsMade = [...toolCallsMade, toolCall];
          appendVoiceLog(options.log, {
            turnIndex: options.turnIndex,
            type: "tool_activity",
            text: formatToolResultForLog(toolCall),
            data: { toolCall, mode: "agent" },
          });
          options.onToolResult?.(toolCall);
        }
      );

      assistantText = loopResult.finalAnswer ||
        (loopResult.error
          ? userFriendlyAgentError(loopResult.error, options.voice)
          : userFriendlyAgentError("The agent finished without a final answer.", options.voice));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assistantText = userFriendlyAgentError(message, options.voice);
      appendVoiceLog(options.log, {
        turnIndex: options.turnIndex,
        type: "error",
        text: message,
        data: { mode: "agent" },
      });
    } finally {
      if (!interrupted && assistantText.trim()) {
        chunker.push(assistantText);
      }
      chunker.close();
    }

    try {
      await ttsPromise;
    } catch (err) {
      if (!interrupted) {
        throw err;
      }
    }

    const savedAssistantText = interrupted
      ? `${assistantText.trim()}\n[interrupted]`.trim()
      : assistantText;

    options.session.messages.push({
      role: "model",
      content: savedAssistantText,
      timestamp: now(),
    });
    (options.saveSession || saveSession)(options.session);

    const metrics = {
      ttsFirstAudioMs,
      ttsChunkMs,
      playbackStopMs,
      endToEndMs: now() - startedAt,
    };
    appendVoiceLog(options.log, {
      turnIndex: options.turnIndex,
      type: "assistant_final",
      text: savedAssistantText,
      data: { interrupted, mode: "agent", steps, toolCallCount: toolCallsMade.length },
    });
    appendVoiceLog(options.log, {
      turnIndex: options.turnIndex,
      type: "metrics",
      data: metrics,
    });

    settled = true;
    return {
      text: savedAssistantText,
      interrupted,
      metrics,
      inputTokens,
      outputTokens,
      steps,
      toolCallsMade,
    };
  })().finally(() => {
    settled = true;
  });

  return {
    done,
    interrupt,
    isInterrupted: () => interrupted,
    isSettled: () => settled,
  };
}

export async function voiceChatCommand(options: VoiceChatOptions): Promise<void> {
  let config = loadConfig({
    apiKey: options.key,
    model: options.model,
  });
  let provider = createProvider(config);
  const voice = config.voice;
  let voiceDesignPrompt = loadVoiceDesignPrompt(voice);
  const promptValidation = validatePrompts({ promptsDir: voice.promptsDir });
  const session = createSession(config.model);
  const voiceLog = createVoiceTranscriptLog(config.model, voice.language);
  const state = new VoiceConversationState({ debug: voice.debugTranscript });
  const microphone = new FfmpegMicrophoneCapture();
  const sttProvider = createSTTProvider(voice);
  let ttsProvider = createTTSProvider(voice);
  const playback = new CancellablePlaybackQueue(new SystemAudioOutput());
  const agentMode = options.agent === true;
  let activeTools: { names: string[]; tools: IToolProvider[] } = agentMode
    ? resolveVoiceTools(options.tools)
    : { names: [], tools: [] };
  const sandboxDir = agentMode ? resolveVoiceSandbox(options.sandbox) : "";
  const agentMaxSteps = parsePositiveInteger(options.agentMaxSteps, 20);
  const interruptController = new InterruptController(playback, {
    enabled: voice.bargeIn,
    vad: {
      threshold: voice.vadThreshold,
      speechStartMs: voice.vadSpeechMs,
      silenceEndMs: voice.vadSilenceMs,
      sampleRate: voice.sampleRate,
    },
  });
  const commands = createCommandQueue();
  const listenWindowMs = Math.max(350, Math.round(Number.parseFloat(options.listenWindow || "1.2") * 1000));
  let muted = false;
  let running = true;
  let activeTurn: VoiceAssistantTurn | undefined;
  let pendingTranscript: string | undefined;

  console.log("Voice chat");
  console.log(`Language: ${voice.language} | Provider: ${config.provider} | Model: ${config.model}`);
  console.log(`TTS: ${ttsProvider.name} | Voice: ${activeTtsVoice(voice)}`);
  if (voice.bargeIn) {
    console.log(`Barge-in: ${voice.bargeInThreshold !== undefined
      ? `fixed threshold ${voice.bargeInThreshold}`
      : `adaptive (ratio ${BARGE_IN_NOISE_RATIO})`} | onset ${voice.bargeInSpeechMs} ms`);
  }
  console.log(`Mode: ${agentMode ? "agentic voice (final answers spoken)" : "plain low-latency voice"}`);
  if (agentMode) {
    console.log(`Tools: ${activeTools.names.length > 0 ? activeTools.names.join(", ") : "(none)"}`);
    console.log(`Sandbox: ${sandboxDir}`);
    if (!provider.promptWithTools) {
      console.warn(`Agent warning: provider "${provider.name}" does not support tool use.`);
    }
  }
  console.log(`Transcript log: ${voiceLog.filePath}`);
  console.log("Commands: /exit /mute /unmute /interrupt /provider <google|github|ollama> /model <name> /tts <piper|supertonic|qwen3> /tts-voice <name> /reload-prompts /voice-style /debug on|off" + (agentMode ? " /tools" : ""));
  if (!promptValidation.ok) {
    console.warn(`Prompt warning: ${promptValidation.errors.join("; ")}`);
  }

  try {
    await checkSetup(sttProvider, ttsProvider);

    while (running) {
      await drainCommands(commands, handleCommand);
      if (!running) {
        break;
      }

      if (muted) {
        state.setMuted(true);
        printState(state);
        await delay(250);
        continue;
      }

      const turnIndex = state.beginTurn();
      state.setStatus("listening", "listening");
      printState(state);

      const transcript = pendingTranscript || await listenForTranscript({
        microphone,
        sttProvider,
        voice,
        deviceName: options.device,
        windowMs: listenWindowMs,
        state,
        log: voiceLog,
        turnIndex,
        shouldContinue: () => running && !muted,
        handleCommands: () => drainCommands(commands, handleCommand),
      });
      pendingTranscript = undefined;

      if (!running || !transcript) {
        continue;
      }

      state.setStatus("thinking");
      appendVoiceTranscriptEvent(voiceLog, {
        turnIndex,
        type: "final_transcript",
        text: transcript,
      });
      console.log(`You: ${transcript}`);

      activeTurn = agentMode
        ? startVoiceAgentAssistantTurn({
            provider,
            ttsProvider,
            playback,
            interruptController,
            session,
            userTranscript: transcript,
            voice,
            voiceDesignPrompt,
            log: voiceLog,
            turnIndex,
            tools: activeTools.tools,
            sandboxDir,
            maxSteps: agentMaxSteps,
            onAgentStep: (step) => {
              console.log(formatAgentStepForDisplay(step));
            },
            onToolResult: (toolCall) => {
              console.log(formatToolResultForDisplay(toolCall));
            },
          })
        : startVoiceAssistantTurn({
            provider,
            ttsProvider,
            playback,
            interruptController,
            session,
            userTranscript: transcript,
            voice,
            voiceDesignPrompt,
            log: voiceLog,
            turnIndex,
          });
      state.setStatus("speaking", "speaking");

      // The monitor runs unawaited until the turn settles; catch its failures
      // here (e.g. an ffmpeg device error) so they degrade to "no barge-in"
      // instead of dying as an unhandled rejection mid-turn.
      const bargeInPromise = voice.bargeIn
        ? monitorBargeIn({
            activeTurn,
            microphone,
            sttProvider,
            voice,
            deviceName: options.device,
            state,
            log: voiceLog,
            turnIndex,
            shouldContinue: () => running && !muted,
          }).catch((err) => {
            appendVoiceTranscriptEvent(voiceLog, {
              turnIndex,
              type: "error",
              text: `barge-in monitor failed: ${err instanceof Error ? err.message : String(err)}`,
            });
            return undefined;
          })
        : Promise.resolve(undefined);

      const result = await activeTurn.done;
      const interruptionTranscript = await bargeInPromise;
      pendingTranscript = interruptionTranscript || undefined;
      activeTurn = undefined;

      state.markMetric("llmFirstTokenMs", result.metrics.llmFirstTokenMs ?? 0);
      state.markMetric("ttsFirstAudioMs", result.metrics.ttsFirstAudioMs ?? 0);
      state.markMetric("playbackStopMs", result.metrics.playbackStopMs ?? 0);
      state.markMetric("endToEndMs", result.metrics.endToEndMs);
      state.setStatus(result.interrupted ? "interrupted" : "listening", result.interrupted ? "interrupted" : "listening");
      console.log(`Assistant${result.interrupted ? " (interrupted)" : ""}: ${result.text.replace(/\n\[interrupted\]$/, "")}`);
      printMetrics(result.metrics);
    }
  } catch (err) {
    state.setError(err);
    appendVoiceTranscriptEvent(voiceLog, {
      turnIndex: state.turnIndex,
      type: "error",
      text: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    commands.close();
    await playback.stop();
    appendVoiceTranscriptEvent(voiceLog, {
      turnIndex: state.turnIndex,
      type: "session_end",
      data: { ...state.snapshot() },
    });
  }

  async function handleCommand(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) {
      return;
    }

    const [command, ...rest] = trimmed.slice(1).split(/\s+/);
    const args = rest.join(" ");
    appendVoiceTranscriptEvent(voiceLog, {
      turnIndex: state.turnIndex,
      type: "command",
      text: trimmed,
    });

    switch (command) {
      case "exit":
        running = false;
        await activeTurn?.interrupt("exit");
        break;
      case "mute":
        muted = true;
        state.setMuted(true);
        break;
      case "unmute":
        muted = false;
        state.setMuted(false);
        break;
      case "interrupt":
        await activeTurn?.interrupt("manual");
        break;
      case "provider":
        config = switchProvider(config, args);
        provider = createProvider(config);
        session.model = config.model;
        console.log(`Provider: ${config.provider} | Model: ${config.model}`);
        if (agentMode && !provider.promptWithTools) {
          console.log(`Agent mode warning: provider "${provider.name}" does not support tool use.`);
        }
        break;
      case "model":
        if (!args) {
          console.log("Usage: /model <name>");
          break;
        }
        config = { ...config, model: args };
        session.model = args;
        provider = createProvider(config);
        console.log(`Model: ${args}`);
        if (agentMode && !provider.promptWithTools) {
          console.log(`Agent mode warning: provider "${provider.name}" does not support tool use.`);
        }
        break;
      case "tts": {
        const selected = args === "qwen3" ? "qwen3-tts" : args;
        if (!["piper", "supertonic", "qwen3-tts"].includes(selected)) {
          console.log("Usage: /tts <piper|supertonic|qwen3>");
          break;
        }
        if (activeTurn && !activeTurn.isSettled()) await activeTurn.interrupt("tts-switch");
        voice.ttsProvider = selected;
        ttsProvider = createTTSProvider(voice);
        const setup = await ttsProvider.checkSetup();
        if (!setup.ok) {
          console.log(`TTS ${selected} is not ready: ${setup.details}`);
        } else {
          console.log(`TTS: ${ttsProvider.name} | Voice: ${activeTtsVoice(voice)} (${setup.details})`);
        }
        break;
      }
      case "tts-voice":
        if (!args) {
          console.log("Usage: /tts-voice <Piper model path | Supertonic preset>");
          break;
        }
        if (voice.ttsProvider === "piper") voice.piperVoice = args;
        else if (voice.ttsProvider === "supertonic") voice.supertonicVoice = args;
        else {
          console.log("Qwen3-TTS voice is configured by prompts/voice-style.md.");
          break;
        }
        if (activeTurn && !activeTurn.isSettled()) await activeTurn.interrupt("tts-voice-switch");
        ttsProvider = createTTSProvider(voice);
        console.log(`TTS voice: ${activeTtsVoice(voice)}`);
        break;
      case "tools":
        if (!agentMode) {
          console.log("Tool controls are available only in voice-chat --agent.");
          break;
        }
        activeTools = handleToolsCommand(args, activeTools);
        break;
      case "reload-prompts":
        voiceDesignPrompt = loadVoiceDesignPrompt(voice);
        console.log("Prompts reloaded.");
        break;
      case "voice-style":
        console.log(voiceDesignPrompt.trim());
        break;
      case "debug":
        state.setDebug(args === "on");
        console.log(`Debug: ${args === "on" ? "on" : "off"}`);
        break;
      default:
        console.log(`Unknown command: /${command}`);
    }
  }
}

async function checkSetup(sttProvider: ISTTProvider, ttsProvider: ITTSProvider): Promise<void> {
  const stt = await sttProvider.checkSetup();
  if (!stt.ok) {
    throw new Error(`STT setup failed: ${stt.details}`);
  }

  const tts = await ttsProvider.checkSetup();
  if (!tts.ok) {
    throw new Error(`TTS setup failed: ${tts.details}`);
  }
}

const MAX_UTTERANCE_MS = 15000;

async function listenForTranscript(options: {
  microphone: MicrophoneCapture;
  sttProvider: ISTTProvider;
  voice: VoiceConfig;
  deviceName?: string;
  windowMs: number;
  state: VoiceConversationState;
  log: VoiceTranscriptLog;
  turnIndex: number;
  shouldContinue: () => boolean;
  handleCommands: () => Promise<void>;
}): Promise<string | undefined> {
  // Cadence for no-speech level reports; the mic stream itself stays open the
  // whole time (closing and reopening it loses audio at every boundary).
  const reportIntervalMs = Math.max(2000, options.windowMs);
  let consecutiveSilentWindows = 0;
  let warnedSilentStream = false;

  while (options.shouldContinue()) {
    await options.handleCommands();
    if (!options.shouldContinue()) {
      break;
    }

    // The stream blocks until speech is captured, so poll commands/mute from a
    // timer and abort the capture when the caller needs control back.
    const controller = new AbortController();
    const poll = setInterval(() => {
      options.handleCommands().catch((err) => {
        console.error(`Command failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      if (!options.shouldContinue()) {
        controller.abort();
      }
    }, 250);

    let utterance;
    try {
      utterance = await options.microphone.recordUtterance({
        sampleRate: options.voice.sampleRate,
        deviceName: options.deviceName,
        threshold: options.voice.vadThreshold,
        speechStartMs: options.voice.vadSpeechMs,
        silenceEndMs: options.voice.vadSilenceMs,
        minThreshold: options.voice.vadMinThreshold,
        maxDurationMs: MAX_UTTERANCE_MS,
        noSpeechReportIntervalMs: reportIntervalMs,
        signal: controller.signal,
        onVadEvent: (event, levels) => {
          appendVoiceTranscriptEvent(options.log, {
            turnIndex: options.turnIndex,
            type: "vad",
            data: {
              phase: "listen",
              event: event.type,
              durationMs: Math.round(event.durationMs),
              energy: event.energy,
              noiseFloor: levels.noiseFloor,
              effectiveThreshold: levels.effectiveThreshold,
            },
          });
        },
        onNoSpeech: (levels) => {
          if (options.state.snapshot().debug) {
            console.log(
              `\n[mic] no speech: peak RMS ${levels.maxEnergy.toFixed(4)}, noise floor ${levels.noiseFloor.toFixed(4)}, threshold ${levels.effectiveThreshold.toFixed(4)}`
            );
          }
          if (levels.maxEnergy < SILENT_CAPTURE_RMS) {
            consecutiveSilentWindows += 1;
            if (!warnedSilentStream && consecutiveSilentWindows >= 3) {
              warnedSilentStream = true;
              console.warn(
                `\n[mic] The input stream looks silent (peak RMS ${levels.maxEnergy.toFixed(4)}). ` +
                  `The device "${options.deviceName ?? "default"}" is capturing no audio: ` +
                  "check --device, the input level in Windows Sound settings, and microphone privacy settings. " +
                  "Run \"npm run dev -- voice-check\" for a full diagnosis."
              );
            }
          } else {
            consecutiveSilentWindows = 0;
          }
        },
      });
    } finally {
      clearInterval(poll);
    }

    if (!utterance) {
      continue;
    }

    options.state.setStatus("transcribing");
    const startedAt = Date.now();
    const transcript = await collectTranscriptWithPartials(
      options.sttProvider.transcribe(utterance, { language: options.voice.language }),
      options.log,
      options.turnIndex
    );
    options.state.markMetric("sttFinalMs", Date.now() - startedAt);
    if (transcript.trim()) {
      return transcript.trim();
    }
  }

  return undefined;
}

async function collectTranscriptWithPartials(
  events: AsyncIterable<TranscriptEvent>,
  log: VoiceTranscriptLog,
  turnIndex: number
): Promise<string> {
  let finalText = "";

  for await (const event of events) {
    if (event.type === "partial") {
      appendVoiceTranscriptEvent(log, {
        turnIndex,
        type: "partial_transcript",
        text: event.text,
        data: { timestampMs: event.timestampMs },
      });
      process.stdout.write(`\r... ${event.text.slice(-90)}`);
    }
    if (event.type === "final") {
      finalText = event.text;
    }
    if (event.type === "error") {
      throw event.error;
    }
  }

  if (finalText) {
    process.stdout.write("\n");
  }
  return finalText;
}

// While the assistant is speaking, its own voice bleeds from the speakers into
// the microphone and raises the tracked noise floor. Only a voice clearly above
// that floor should count as a barge-in, so the monitor demands a larger
// speech-to-floor ratio than normal listening.
const BARGE_IN_NOISE_RATIO = 3.5;

async function monitorBargeIn(options: {
  activeTurn: VoiceAssistantTurn;
  microphone: MicrophoneCapture;
  sttProvider: ISTTProvider;
  voice: VoiceConfig;
  deviceName?: string;
  state: VoiceConversationState;
  log: VoiceTranscriptLog;
  turnIndex: number;
  shouldContinue: () => boolean;
}): Promise<string | undefined> {
  while (!options.activeTurn.isSettled() && options.shouldContinue()) {
    let barged = false;

    // Listen for the user cutting in. On speech onset we interrupt the assistant
    // immediately, but keep recording so we capture the WHOLE interrupting
    // utterance (not just the first 350 ms) to seed the next turn. The stream
    // stays open for the whole assistant turn; a timer aborts it once the turn
    // settles without a barge-in.
    const controller = new AbortController();
    const poll = setInterval(() => {
      if (!barged && (options.activeTurn.isSettled() || !options.shouldContinue())) {
        controller.abort();
      }
    }, 150);

    let utterance;
    try {
      // VOICE_BARGEIN_THRESHOLD (when set from calibration) is a fixed cutoff.
      // Otherwise the adaptive VAD tracks the bleed of the assistant's own
      // voice as noise floor, with a stricter ratio and a longer speech onset
      // than normal listening so only a real, sustained voice interrupts.
      // The old fixed VOICE_VAD_THRESHOLD cutoff (0.018) was never reached on
      // quiet capture devices, which made barge-in silently inoperative.
      utterance = await options.microphone.recordUtterance({
        sampleRate: options.voice.sampleRate,
        deviceName: options.deviceName,
        threshold: options.voice.bargeInThreshold ?? options.voice.vadThreshold,
        speechStartMs: options.voice.bargeInSpeechMs,
        silenceEndMs: options.voice.vadSilenceMs,
        minThreshold: options.voice.vadMinThreshold,
        noiseToSpeechRatio: BARGE_IN_NOISE_RATIO,
        maxDurationMs: MAX_UTTERANCE_MS,
        signal: controller.signal,
        fixedThreshold: options.voice.bargeInThreshold !== undefined,
        noSpeechReportIntervalMs: 2000,
        onNoSpeech: (levels) => {
          appendVoiceTranscriptEvent(options.log, {
            turnIndex: options.turnIndex,
            type: "vad",
            data: {
              phase: "barge-in",
              event: "levels",
              maxEnergy: levels.maxEnergy,
              noiseFloor: levels.noiseFloor,
              effectiveThreshold: levels.effectiveThreshold,
            },
          });
        },
        onVadEvent: (event, levels) => {
          appendVoiceTranscriptEvent(options.log, {
            turnIndex: options.turnIndex,
            type: "vad",
            data: {
              phase: "barge-in",
              event: event.type,
              durationMs: Math.round(event.durationMs),
              energy: event.energy,
              noiseFloor: levels.noiseFloor,
              effectiveThreshold: levels.effectiveThreshold,
            },
          });
        },
        onSpeechStart: () => {
          if (options.activeTurn.isSettled()) {
            return;
          }
          barged = true;
          options.state.setStatus("interrupted", "interrupted");
          // Fire-and-forget, but with a handler: `void` alone leaves a
          // rejection unhandled, which crashes the process (nbind).
          options.activeTurn.interrupt("barge-in").catch(() => undefined);
        },
      });
    } finally {
      clearInterval(poll);
    }

    if (!utterance || !barged) {
      continue;
    }

    try {
      return await collectFinalTranscript(options.sttProvider.transcribe(utterance, {
        language: options.voice.language,
      }));
    } catch (err) {
      appendVoiceTranscriptEvent(options.log, {
        turnIndex: options.turnIndex,
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  return undefined;
}

function buildVoiceUserMessage(transcript: string, voice: VoiceConfig): string {
  const persona = renderPrompt("persona", {}, { promptsDir: voice.promptsDir });
  const languageInstruction = voice.language === "fr"
    ? "Reponds en francais, naturellement et de facon concise."
    : "Respond in English, naturally and concisely.";

  return [
    "Voice conversation instructions:",
    persona.trim(),
    languageInstruction,
    "",
    "User transcript:",
    transcript,
  ].join("\n");
}

function buildVoiceAgentPrompt(transcript: string, voice: VoiceConfig): string {
  const persona = renderPrompt("persona", {}, { promptsDir: voice.promptsDir });
  const agent = renderPrompt("agent", {}, { promptsDir: voice.promptsDir });
  const languageInstruction = voice.language === "fr"
    ? "Reponds en francais. Utilise les outils seulement quand ils aident vraiment, puis donne une reponse finale claire et concise qui peut etre lue a voix haute."
    : "Respond in English. Use tools only when they are genuinely helpful, then provide a clear concise final answer that can be spoken aloud.";

  return [
    "Voice agent conversation instructions:",
    persona.trim(),
    "",
    agent.trim(),
    "",
    languageInstruction,
    "",
    "User transcript:",
    transcript,
  ].join("\n");
}

function resolveVoiceTools(rawTools?: string): { names: string[]; tools: IToolProvider[] } {
  if (rawTools === undefined) {
    return {
      names: getAllToolNames(),
      tools: getAllTools(),
    };
  }

  const trimmed = rawTools.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") {
    return {
      names: [],
      tools: [],
    };
  }

  if (trimmed.toLowerCase() === "all") {
    return {
      names: getAllToolNames(),
      tools: getAllTools(),
    };
  }

  const names = trimmed
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);

  return {
    names,
    tools: getTools(names),
  };
}

function handleToolsCommand(
  args: string,
  current: { names: string[]; tools: IToolProvider[] }
): { names: string[]; tools: IToolProvider[] } {
  if (!args.trim()) {
    console.log(
      [
        `Active tools: ${current.names.length > 0 ? current.names.join(", ") : "(none)"}`,
        `Available: ${getAllToolNames().join(", ")}`,
        "Usage: /tools all | /tools none | /tools <a,b,c>",
      ].join("\n")
    );
    return current;
  }

  try {
    const next = resolveVoiceTools(args);
    console.log(`Active tools: ${next.names.length > 0 ? next.names.join(", ") : "(none)"}`);
    return next;
  } catch (err) {
    console.log(`Tool error: ${err instanceof Error ? err.message : String(err)}`);
    return current;
  }
}

function resolveVoiceSandbox(rawSandbox?: string): string {
  const sandboxDir = rawSandbox
    ? path.resolve(rawSandbox)
    : path.join(process.cwd(), `llmtest-voice-agent-sandbox-${Date.now()}`);

  if (!fs.existsSync(sandboxDir)) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  return sandboxDir;
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatAgentStepForDisplay(step: AgentStepResult): string {
  if (step.type === "tool_call") {
    return `[tool] ${step.toolName ?? "unknown"} ${JSON.stringify(step.toolParams ?? {})}`;
  }

  return "[agent] final answer ready";
}

function formatToolResultForDisplay(toolCall: ToolCallRecord): string {
  const result = summarizeToolResult(toolCall.result);
  return `[tool result] ${toolCall.name}: ${result}`;
}

function formatAgentStepForLog(step: AgentStepResult): string {
  return step.type === "tool_call"
    ? `tool_call ${step.toolName ?? "unknown"} ${JSON.stringify(step.toolParams ?? {})}`
    : "final_answer";
}

function formatToolResultForLog(toolCall: ToolCallRecord): string {
  return `${toolCall.name}: ${summarizeToolResult(toolCall.result)}`;
}

function summarizeToolResult(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (!text) {
    return "(empty)";
  }
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function userFriendlyAgentError(error: string, voice: VoiceConfig): string {
  if (error.includes("does not support tool use")) {
    return voice.language === "fr"
      ? "Le fournisseur actuel ne prend pas en charge les outils. Essaie le mode vocal simple, ou choisis un fournisseur compatible avec les outils."
      : "The current provider does not support tools. Try plain voice chat, or switch to a tool-capable provider.";
  }

  if (error.includes("max steps exceeded")) {
    return voice.language === "fr"
      ? "J'ai atteint la limite d'etapes de l'agent avant de pouvoir terminer. Je peux reessayer avec une demande plus ciblee."
      : "I reached the agent step limit before I could finish. I can try again with a narrower request.";
  }

  return voice.language === "fr"
    ? `Le mode agent a rencontre une erreur: ${error}`
    : `Agent mode ran into an error: ${error}`;
}

function findChunkBoundary(text: string, minChars: number, maxChars: number, force: boolean): number {
  const searchEnd = Math.min(text.length, maxChars);
  const prefix = text.slice(0, searchEnd);
  const sentenceMatches = [...prefix.matchAll(/[.!?;:]\s+/g)];
  const lastSentence = sentenceMatches.at(-1);
  // The first complete sentence starts TTS immediately, even below minChars.
  if (lastSentence && ((lastSentence.index ?? 0) + 1 >= minChars || text.length < minChars)) {
    return (lastSentence.index ?? 0) + 1;
  }

  if (!force && text.length < minChars) return -1;

  if (text.length >= maxChars) {
    const space = prefix.lastIndexOf(" ");
    return space >= minChars ? space : maxChars;
  }

  return force ? text.length : -1;
}

function appendVoiceLog(
  log: VoiceTranscriptLog | undefined,
  event: Parameters<typeof appendVoiceTranscriptEvent>[1]
): void {
  if (log) {
    appendVoiceTranscriptEvent(log, event);
  }
}

function createCommandQueue(): {
  readAll(): string[];
  close(): void;
} {
  const lines: string[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("line", (line) => {
    lines.push(line);
  });

  return {
    readAll() {
      return lines.splice(0);
    },
    close() {
      rl.close();
    },
  };
}

async function drainCommands(
  commands: { readAll(): string[] },
  handler: (line: string) => Promise<void>
): Promise<void> {
  for (const line of commands.readAll()) {
    await handler(line);
  }
}

function switchProvider(currentConfig: AppConfig, rawProvider: string): AppConfig {
  const providerName = rawProvider.trim() as AppConfig["provider"];
  if (!["google", "github", "ollama"].includes(providerName)) {
    console.log("Usage: /provider <google|github|ollama>");
    return currentConfig;
  }

  return loadConfig({ provider: providerName });
}

function printState(state: VoiceConversationState): void {
  const snapshot = state.snapshot();
  process.stdout.write(`\r[${snapshot.status}] turn ${snapshot.turnIndex}   `);
}

function printMetrics(metrics: VoiceAssistantTurnResult["metrics"]): void {
  const parts = [
    metrics.llmFirstTokenMs !== undefined ? `LLM first token ${metrics.llmFirstTokenMs} ms` : undefined,
    metrics.ttsFirstAudioMs !== undefined ? `TTS first audio ${metrics.ttsFirstAudioMs} ms` : undefined,
    metrics.ttsChunkMs.length > 0 ? `TTS chunks ${metrics.ttsChunkMs.join(", ")} ms` : undefined,
    metrics.playbackStopMs !== undefined ? `stop ${metrics.playbackStopMs} ms` : undefined,
    `turn ${metrics.endToEndMs} ms`,
  ].filter(Boolean);
  console.log(`Metrics: ${parts.join(" | ")}`);
}

function activeTtsVoice(voice: VoiceConfig): string {
  if (voice.ttsProvider === "piper") return voice.piperVoice || "(default)";
  if (voice.ttsProvider === "supertonic") return voice.supertonicVoice || "(default)";
  return "voice-style prompt";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
