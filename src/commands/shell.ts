/**
 * shell command — Persistent interactive REPL for running llmtest subcommands.
 */

import * as readline from "readline";
import { loadConfig } from "../config/loader";
import { validateCommand } from "./validate";
import { configCommand } from "./config";
import { modelsCommand } from "./models";
import { promptCommand } from "./prompt";
import { chatCommand } from "./chat";
import { runCommand } from "./run";
import { agentCommand } from "./agent";
import { ragCommand } from "./rag";
import { compareCommand } from "./compare";
import { convoCommand } from "./convo";
import { agentChatCommand } from "./agentChat";

const VERSION = "0.1.0";

export async function shellCommand(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch {
    // Config may fail if no key is set — still allow shell to start
    config = null;
  }

  const modelDisplay = config ? config.model : "not configured";

  // Print welcome banner
  console.log("");
  console.log("  ╔═══════════════════════════════════════╗");
  console.log(`  ║  llmtest shell v${VERSION}               ║`);
  console.log(`  ║  Active model: ${pad(modelDisplay, 23)}║`);
  console.log("  ╚═══════════════════════════════════════╝");
  console.log("");
  console.log("  Type 'help' for available commands, 'exit' to quit.");
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "llmtest> ",
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    const spaceIdx = trimmed.indexOf(" ");
    const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    try {
      await dispatchCommand(command, args);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nGoodbye!");
    process.exit(0);
  });
}

async function dispatchCommand(
  command: string,
  args: string
): Promise<void> {
  switch (command.toLowerCase()) {
    case "validate":
      await validateCommand({});
      break;

    case "prompt":
      if (!args) {
        console.log("Usage: prompt <text>");
        break;
      }
      await promptCommand(args, {});
      break;

    case "chat":
      await chatCommand({});
      break;

    case "run":
      if (!args) {
        console.log("Usage: run <file>");
        break;
      }
      await runCommand(args, {});
      break;

    case "agent":
      if (!args) {
        console.log("Usage: agent <file>");
        break;
      }
      await agentCommand(args, {});
      break;

    case "rag":
      if (!args) {
        console.log("Usage: rag <file>");
        break;
      }
      await ragCommand(args, {});
      break;

    case "compare": {
      if (!args) {
        console.log("Usage: compare <file> --models <model1,model2>");
        break;
      }
      const modelsMatch = args.match(/--models\s+(\S+)/);
      if (!modelsMatch) {
        console.log("Usage: compare <file> --models <model1,model2>");
        break;
      }
      const compareFile = args.replace(/--models\s+\S+/, "").trim();
      await compareCommand(compareFile, { models: modelsMatch[1] });
      break;
    }

    case "convo":
      if (!args) {
        console.log("Usage: convo <file>");
        break;
      }
      await convoCommand(args, {});
      break;

    case "agent-chat":
      await agentChatCommand({});
      break;

    case "config":
      await configCommand();
      break;

    case "models":
      await modelsCommand({});
      break;

    case "help":
      printHelp();
      break;

    case "exit":
    case "quit":
      console.log("Goodbye!");
      process.exit(0);
      break;

    default:
      console.log(
        `Unknown command: '${command}'. Type 'help' for available commands.`
      );
      break;
  }
}

function printHelp(): void {
  console.log("");
  console.log("  Available commands:");
  console.log("");
  console.log("    validate          Validate your API key");
  console.log("    prompt <text>     Send a single prompt");
  console.log("    chat              Start an interactive chat session");
  console.log("    run <file>        Run a benchmark test suite");
  console.log("    agent <file>      Run an agentic test suite");
  console.log("    rag <file>        Run a RAG test suite");
  console.log("    compare <file> --models <list>  Compare models side-by-side");
  console.log("    convo <file>      Run a multi-turn conversation test suite");
  console.log("    agent-chat        Start an interactive agent chat session");
  console.log("    config            Show resolved configuration");
  console.log("    models            List available models");
  console.log("    help              Show this help message");
  console.log("    exit              Exit the shell");
  console.log("");
}

function pad(str: string, len: number): string {
  if (str.length >= len) return str.substring(0, len);
  return str + " ".repeat(len - str.length);
}
