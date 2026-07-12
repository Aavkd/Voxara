/**
 * agent-chat command — Interactive agent chat session with tool use and RAG context.
 *
 * Phase J.2 (E8: Agent Chat)
 */

import React from "react";
import * as fs from "fs";
import * as path from "path";
import { render } from "ink";
import { loadConfig } from "../config/loader";
import { createProvider } from "../providers/factory";
import { ILLMProvider } from "../providers/ILLMProvider";
import { getTools, getAllTools, getAllToolNames } from "../providers/tools/index";
import { IToolProvider } from "../providers/tools/IToolProvider";
import { runAgentLoop } from "../engine/agentLoop";
import { loadDocuments } from "../rag/documentLoader";
import { buildContextPrompt } from "../rag/contextBuilder";
import {
  loadAgentSession,
  saveAgentSession,
  createAgentSession,
  clearAgentSession,
} from "../session/session";
import AgentChatInterface from "../display/components/AgentChatInterface";
import SessionPrompt from "../display/components/SessionPrompt";
import {
  Message,
  AgentStepResult,
  AgentSession,
  Session,
  AppConfig,
} from "../types";
import {
  ensureMemoryLayout,
  buildMemoryContextBlock,
  readMemoryIndex,
} from "../memory/memoryStore";
import {
  consolidateOnExit,
  startConsolidationSweep,
} from "../memory/consolidation";

export async function agentChatCommand(options: {
  key?: string;
  model?: string;
  tools?: string;
  docs?: string;
  sandbox?: string;
}): Promise<void> {
  let config: AppConfig = loadConfig({ apiKey: options.key, model: options.model });

  ensureMemoryLayout();

  // Catch-up sweep for transcripts left unconsolidated by a crash or kill —
  // fire-and-forget so the conversation never waits on memory work.
  startConsolidationSweep(config);

  // ── Parse tools ──────────────────────────────────────────────────
  // If --tools is omitted, default to ALL registered tools so the agent can
  // pick the right tool for each task. Pass --tools "" or "none" to opt out.
  let toolNames: string[];
  let activeTools: IToolProvider[];
  try {
    if (options.tools === undefined) {
      activeTools = getAllTools();
      toolNames = getAllToolNames();
    } else {
      const trimmed = options.tools.trim();
      if (trimmed === "" || trimmed.toLowerCase() === "none") {
        activeTools = [];
        toolNames = [];
      } else {
        toolNames = trimmed
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        activeTools = getTools(toolNames);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
    return;
  }

  // ── Load initial RAG context ─────────────────────────────────────
  const loadedDocPaths: string[] = [];
  const loadedDocContents: string[] = [];

  if (options.docs) {
    const rawPaths = options.docs
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    for (const docPath of rawPaths) {
      try {
        const contents = await loadDocuments(
          [{ source: "file", path: docPath }],
          process.cwd()
        );
        loadedDocContents.push(...contents);
        loadedDocPaths.push(docPath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error loading doc "${docPath}": ${msg}`);
        process.exit(1);
        return;
      }
    }
  }

  // ── Resolve sandbox directory ────────────────────────────────────
  const sandboxDir = options.sandbox
    ? path.resolve(options.sandbox)
    : path.join(process.cwd(), `llmtest-sandbox-${Date.now()}`);

  if (!fs.existsSync(sandboxDir)) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  // ── Session handling ─────────────────────────────────────────────
  let session: AgentSession;
  const existingSession = loadAgentSession();

  if (existingSession) {
    const shouldResume = await promptAgentSessionResume(existingSession);
    if (shouldResume) {
      session = existingSession;
    } else {
      clearAgentSession();
      session = createAgentSession(config.model, toolNames, loadedDocPaths);
    }
  } else {
    session = createAgentSession(config.model, toolNames, loadedDocPaths);
  }

  // ── Mutable state ────────────────────────────────────────────────
  const state = {
    messages: [...(session.messages as Message[])],
    activeTools: toolNames,
    activeToolImpls: activeTools,
    loadedDocs: [...loadedDocPaths],
    isAgentWorking: false,
    currentTrace: [] as AgentStepResult[],
    cumulativeTokens: { input: 0, output: 0 },
  };

  let provider: ILLMProvider = createProvider(config);
  let rerenderFn: ((node: React.ReactElement) => void) | null = null;

  const renderComponent = (): void => {
    const element = React.createElement(AgentChatInterface, {
      messages: state.messages,
      activeTools: state.activeTools,
      loadedDocs: state.loadedDocs,
      isAgentWorking: state.isAgentWorking,
      currentTrace: state.currentTrace,
      cumulativeTokens: state.cumulativeTokens,
      model: config.model,
      onSubmit: handleSubmit,
    });
    if (rerenderFn) {
      rerenderFn(element);
    }
  };

  // ── Input handler ────────────────────────────────────────────────
  const handleSubmit = async (text: string): Promise<void> => {
    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const cmd = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
      await handleSlashCommand(cmd, args);
      return;
    }

    await sendToAgent(text);
  };

  const handleSlashCommand = async (cmd: string, args: string): Promise<void> => {
    switch (cmd) {
      case "tools": {
        const allNames = getAllToolNames();
        if (!args) {
          const toolList =
            state.activeTools.length > 0
              ? state.activeTools.map((t) => `• ${t}`).join("\n")
              : "(no tools active)";
          appendModelMessage(
            `Active tools:\n${toolList}\n\nAvailable: ${allNames.join(", ")}\n` +
              `Usage: /tools all | /tools none | /tools <a,b,c>`
          );
          break;
        }

        const argLC = args.toLowerCase();
        let nextNames: string[];
        let nextImpls: IToolProvider[];
        try {
          if (argLC === "all") {
            nextImpls = getAllTools();
            nextNames = getAllToolNames();
          } else if (argLC === "none") {
            nextImpls = [];
            nextNames = [];
          } else {
            nextNames = args
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t.length > 0);
            nextImpls = getTools(nextNames);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          appendModelMessage(`❌ ${msg}`);
          break;
        }

        state.activeTools = nextNames;
        state.activeToolImpls = nextImpls;
        session.tools = nextNames;
        saveAgentSession(session);
        appendModelMessage(
          nextNames.length > 0
            ? `✅ Active tools: ${nextNames.join(", ")}`
            : `✅ Tools disabled.`
        );
        break;
      }

      case "docs": {
        if (!args) {
          appendModelMessage("Usage: /docs <path>");
          break;
        }
        try {
          const contents = await loadDocuments(
            [{ source: "file", path: args }],
            process.cwd()
          );
          loadedDocContents.push(...contents);
          state.loadedDocs = [...state.loadedDocs, args];
          const charCount = contents.reduce((sum, c) => sum + c.length, 0);
          appendModelMessage(
            `✅ Loaded: ${args} (${charCount.toLocaleString()} chars)`
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          appendModelMessage(`❌ Failed to load doc: ${msg}`);
        }
        break;
      }

      case "info": {
        const info = [
          `Model:   ${config.model}`,
          `Tools:   ${state.activeTools.length > 0 ? state.activeTools.join(", ") : "(none)"}`,
          `Docs:    ${state.loadedDocs.length > 0 ? state.loadedDocs.join(", ") : "(none)"}`,
          `Turns:   ${Math.floor(state.messages.length / 2)}`,
          `Tokens:  ↑ ${state.cumulativeTokens.input} ↓ ${state.cumulativeTokens.output}`,
        ].join("\n");
        appendModelMessage(info);
        break;
      }

      case "clear": {
        state.messages = [];
        state.cumulativeTokens = { input: 0, output: 0 };
        session.messages = [];
        clearAgentSession();
        renderComponent();
        break;
      }

      case "model": {
        if (args) {
          config = { ...config, model: args };
          provider = createProvider(config);
          session.model = args;
          saveAgentSession(session);
          appendModelMessage(`Model switched to: ${args}`);
        }
        break;
      }

      case "memory": {
        const index = readMemoryIndex().trim();
        appendModelMessage(index || "Memory index is empty.");
        break;
      }

      case "exit": {
        saveAgentSession(session);
        // The component calls exit() itself when it receives /exit
        break;
      }

      default: {
        appendModelMessage(
          `Unknown command: /${cmd}. Available: /tools /docs <path> /info /memory /clear /model <name> /exit`
        );
        break;
      }
    }
  };

  const sendToAgent = async (userInput: string): Promise<void> => {
    state.messages = [
      ...state.messages,
      { role: "user" as const, content: userInput, timestamp: Date.now() },
    ];
    state.isAgentWorking = true;
    state.currentTrace = [];
    renderComponent();

    const basePrompt =
      loadedDocContents.length > 0
        ? buildContextPrompt(loadedDocContents, userInput)
        : userInput;

    // Each agent turn is standalone, so the memory context (read fresh from
    // disk) is embedded in the turn prompt rather than the session history.
    const memoryBlock = buildMemoryContextBlock({ withToolInstructions: true });
    const promptToSend = memoryBlock
      ? `${memoryBlock}\n\n---\n\n${basePrompt}`
      : basePrompt;

    try {
      const loopResult = await runAgentLoop(
        provider,
        state.activeToolImpls,
        promptToSend,
        sandboxDir,
        20,
        (step: AgentStepResult) => {
          state.currentTrace = [...state.currentTrace, step];
          renderComponent();
        }
      );

      const finalText =
        loopResult.finalAnswer ||
        "(agent reached max steps without a final answer)";

      state.messages = [
        ...state.messages,
        { role: "model" as const, content: finalText, timestamp: Date.now() },
      ];

      const traceInputTokens = state.currentTrace.reduce(
        (sum, s) => sum + s.inputTokens,
        0
      );
      const traceOutputTokens = state.currentTrace.reduce(
        (sum, s) => sum + s.outputTokens,
        0
      );
      state.cumulativeTokens = {
        input: state.cumulativeTokens.input + traceInputTokens,
        output: state.cumulativeTokens.output + traceOutputTokens,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      state.messages = [
        ...state.messages,
        {
          role: "model" as const,
          content: `❌ Agent error: ${msg}`,
          timestamp: Date.now(),
        },
      ];
    } finally {
      state.isAgentWorking = false;
      state.currentTrace = [];
    }

    session.messages = state.messages;
    session.updatedAt = Date.now();
    saveAgentSession(session);
    renderComponent();
  };

  const appendModelMessage = (content: string): void => {
    state.messages = [
      ...state.messages,
      { role: "model" as const, content, timestamp: Date.now() },
    ];
    session.messages = state.messages;
    renderComponent();
  };

  // ── Initial render ───────────────────────────────────────────────
  const { waitUntilExit, rerender } = render(
    React.createElement(AgentChatInterface, {
      messages: state.messages,
      activeTools: state.activeTools,
      loadedDocs: state.loadedDocs,
      isAgentWorking: state.isAgentWorking,
      currentTrace: state.currentTrace,
      cumulativeTokens: state.cumulativeTokens,
      model: config.model,
      onSubmit: handleSubmit,
    })
  );

  rerenderFn = rerender;

  await waitUntilExit();
  await consolidateOnExit(config);
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Show the agent session resume prompt and return the user's choice.
 * Casts AgentSession to Session — all required Session fields are present.
 */
function promptAgentSessionResume(session: AgentSession): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const { unmount } = render(
      React.createElement(SessionPrompt, {
        session: session as unknown as Session,
        onResume: () => {
          unmount();
          resolve(true);
        },
        onFresh: () => {
          unmount();
          resolve(false);
        },
      })
    );
  });
}
