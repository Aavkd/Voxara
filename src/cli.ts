#!/usr/bin/env node

/**
 * llmtest CLI — Entry point.
 *
 * Registers all commander subcommands and wires them to handler modules.
 */

import { Command } from "commander";
import { validateCommand } from "./commands/validate";
import { configCommand } from "./commands/config";
import { modelsCommand } from "./commands/models";
import { promptCommand } from "./commands/prompt";
import { chatCommand } from "./commands/chat";
import { runCommand } from "./commands/run";
import { shellCommand } from "./commands/shell";
import { agentCommand } from "./commands/agent";
import { ragCommand } from "./commands/rag";
import { compareCommand } from "./commands/compare";
import { convoCommand } from "./commands/convo";
import { agentChatCommand } from "./commands/agentChat";
import { promptsCommand } from "./commands/prompts";
import { memoryCommand } from "./commands/memory";
import { voiceCheckCommand } from "./commands/voiceCheck";
import { voiceChatCommand } from "./commands/voiceChat";
import { ttsCompareCommand } from "./commands/ttsCompare";
import { delegatesCommand } from "./commands/delegates";

const program = new Command();

program
  .name("llmtest")
  .version("0.1.0")
  .description(
    "LLM API Tester CLI — validate keys, test prompts, chat, and benchmark LLM responses"
  );

// ── validate ────────────────────────────────────────────────────────
program
  .command("validate")
  .description("Validate your API key against the configured provider")
  .option("--key <key>", "API key override")
  .option("--model <model>", "Model override")
  .action(async (options: { key?: string; model?: string }) => {
    await validateCommand(options);
  });

// ── prompt ──────────────────────────────────────────────────────────
program
  .command("prompt <text>")
  .description("Send a single prompt and display the response")
  .option("--key <key>", "API key override")
  .option("--model <model>", "Model override")
  .option("--temperature <temp>", "Sampling temperature (0–2)")
  .option("--max-tokens <n>", "Maximum output tokens")
  .option("--system-prompt <text>", "System prompt to prepend")
  .option("--image <path>", "Path to an image file for multi-modal prompts")
  .action(
    async (
      text: string,
      options: {
        key?: string;
        model?: string;
        temperature?: string;
        maxTokens?: string;
        systemPrompt?: string;
        image?: string;
      }
    ) => {
      await promptCommand(text, options);
    }
  );

// ── chat ────────────────────────────────────────────────────────────
program.addCommand(promptsCommand());
program.addCommand(memoryCommand());
program.addCommand(delegatesCommand());

program
  .command("voice-check")
  .description("Run local audio diagnostics for microphone, playback, VAD, and voice config")
  .option("--duration <seconds>", "Microphone recording duration", "2")
  .option("--device <name>", "Microphone device name override")
  .option("--skip-record", "Skip microphone capture")
  .option("--skip-playback", "Skip speaker playback")
  .option("--skip-tts", "Skip configured TTS provider checks")
  .option("--skip-calibration", "Skip the interactive noise/speech/bleed level calibration")
  .option("--keep-recording", "Keep the temporary recorded WAV file")
  .action(
    async (options: {
      duration?: string;
      device?: string;
      skipRecord?: boolean;
      skipPlayback?: boolean;
      skipTts?: boolean;
      skipCalibration?: boolean;
      keepRecording?: boolean;
    }) => {
      await voiceCheckCommand(options);
    }
  );

program
  .command("tts-compare [text]")
  .description("Synthesize and play available Piper, Supertonic, and Qwen3-TTS voices")
  .action(async (text?: string) => {
    await ttsCompareCommand(text);
  });

program
  .command("voice-chat")
  .description("Start a local-first real-time voice conversation loop")
  .option("--key <key>", "API key override")
  .option("--model <model>", "Model override")
  .option("--device <name>", "Microphone device name override")
  .option("--listen-window <seconds>", "Short capture window for turn detection", "1.2")
  .option("--agent", "Enable agent/tool support for voice turns")
  .option("--tools <list>", "Comma-separated tool names for voice agent mode, or all/none")
  .option("--sandbox <dir>", "Override the agent workspace for voice file tools (default: LLMTEST_WORKSPACE_DIR or ~/.llmtest/workspace)")
  .option("--agent-max-steps <n>", "Maximum tool-use steps per voice turn", "20")
  .action(
    async (options: {
      key?: string;
      model?: string;
      device?: string;
      listenWindow?: string;
      agent?: boolean;
      tools?: string;
      sandbox?: string;
      agentMaxSteps?: string;
    }) => {
      await voiceChatCommand(options);
    }
  );

program
  .command("chat")
  .description("Start an interactive chat session with streaming responses")
  .option("--key <key>", "API key override")
  .option("--model <model>", "Model override")
  .action(async (options: { key?: string; model?: string }) => {
    await chatCommand(options);
  });

// ── run ─────────────────────────────────────────────────────────────
program
  .command("run <file>")
  .description("Run a benchmark test suite from a JSON file")
  .option("--key <key>", "API key override")
  .option("--model <model>", "Model override")
  .action(async (file: string, options: { key?: string; model?: string }) => {
    await runCommand(file, options);
  });

// ── agent ───────────────────────────────────────────────────────────
program
  .command("agent <file>")
  .description("Run an agentic test suite with tool-use assertions")
  .option("--key <key>", "API key override")
  .option("--model <model>", "Model override")
  .option("--max-steps <n>", "Maximum agent loop steps")
  .action(
    async (
      file: string,
      options: { key?: string; model?: string; maxSteps?: string }
    ) => {
      await agentCommand(file, options);
    }
  );

// ── rag ─────────────────────────────────────────────────────────────
program
  .command("rag <file>")
  .description("Run a RAG (retrieval-augmented generation) test suite")
  .option("--key <key>", "API key override")
  .option("--model <model>", "Model override")
  .option("--judge-model <name>", "Model to use for faithfulness judging")
  .action(
    async (
      file: string,
      options: { key?: string; model?: string; judgeModel?: string }
    ) => {
      await ragCommand(file, options);
    }
  );

// ── compare ─────────────────────────────────────────────────────────
program
  .command("compare <file>")
  .description("Run a test suite against multiple models and compare results")
  .option("--key <key>", "API key override")
  .requiredOption("--models <list>", "Comma-separated list of models to compare")
  .action(
    async (
      file: string,
      options: { key?: string; models: string }
    ) => {
      await compareCommand(file, options);
    }
  );

// ── convo ────────────────────────────────────────────────────────────
program
  .command("convo <file>")
  .description("Run a multi-turn conversation test suite")
  .option("--key <key>", "API key override")
  .option("--model <model>", "Model override")
  .action(
    async (
      file: string,
      options: { key?: string; model?: string }
    ) => {
      await convoCommand(file, options);
    }
  );

// ── agent-chat ───────────────────────────────────────────────────────
program
  .command("agent-chat")
  .description("Start an interactive agent chat session with tool use and RAG context")
  .option("--key <key>", "API key override")
  .option("--model <model>", "Model override")
  .option("--tools <list>", "Comma-separated list of tool names to enable")
  .option("--docs <paths>", "Comma-separated list of document paths to load as context")
  .option("--sandbox <dir>", "Override the agent workspace for file tools (default: LLMTEST_WORKSPACE_DIR or ~/.llmtest/workspace)")
  .action(
    async (options: {
      key?: string;
      model?: string;
      tools?: string;
      docs?: string;
      sandbox?: string;
    }) => {
      await agentChatCommand(options);
    }
  );

// ── shell ───────────────────────────────────────────────────────────
program
  .command("shell")
  .description("Start a persistent interactive REPL shell")
  .action(async () => {
    await shellCommand();
  });

// ── config ──────────────────────────────────────────────────────────
program
  .command("config")
  .description("Display the resolved configuration with source annotations")
  .action(async () => {
    await configCommand();
  });

// ── models ──────────────────────────────────────────────────────────
program
  .command("models")
  .description("List available models for the configured provider")
  .option("--key <key>", "API key override")
  .option("--model <model>", "Model override")
  .action(async (options: { key?: string; model?: string }) => {
    await modelsCommand(options);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
