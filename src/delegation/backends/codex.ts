/**
 * Codex CLI backend adapter — non-interactive `codex exec` with JSONL events
 * and an explicit sandbox.
 *
 * Phase C2a/C2b (docs/phase-c2-coding-agent-delegation.md §8.2). The task
 * text travels via stdin (never the command line), the working directory and
 * sandbox are explicit, and no approval-bypass flag is ever passed.
 * read_only runs use the `read-only` sandbox; workspace_write runs use the
 * `workspace-write` sandbox with the isolated worktree as cwd (§7), so even
 * on platforms where the OS sandbox enforces nothing (§8.4) the writes land
 * in the disposable worktree. external_action PREPARE runs (C2c §3.3) also
 * use `workspace-write`, but their cwd is the per-task plan directory — the
 * only writable target is the manifest/payload area, and the service rejects
 * the plan if the user workspace changed during the run.
 */

import {
  BackendAvailability,
  BackendRunContext,
  BackendRunOutcome,
  ICodingAgentBackend,
  RunningAgent,
} from "../types";
import { runSupervisedProcess } from "../processRunner";
import {
  createArtifactLogger,
  makeProgressEvent,
  probeVersion,
  resolveBackendExecutable,
} from "./common";

export interface CodexBackendOptions {
  /** Explicit executable path (CODEX_CLI_PATH); PATH lookup otherwise. */
  executablePath?: string;
}

interface ParsedCodexEvent {
  sessionId?: string;
  progressText?: string;
  agentMessage?: string;
  errorText?: string;
}

/**
 * Parse one Codex JSONL event line into the backend-neutral shape. Tolerates
 * both the current `codex exec --json` event stream ({type, item, ...}) and
 * the legacy {id, msg:{type,...}} shape. Malformed lines are reported as
 * bounded progress, never thrown.
 */
export function parseCodexEventLine(line: string): ParsedCodexEvent {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return { progressText: `codex: unparsable event line` };
  }
  if (!event || typeof event !== "object") {
    return {};
  }

  // Current experimental JSON shape: {"type": "...", "item": {...}}
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "thread.started" && typeof event.thread_id === "string") {
    return { sessionId: event.thread_id };
  }
  if (type === "error" && typeof event.message === "string") {
    return { errorText: event.message };
  }
  const item = event.item as Record<string, unknown> | undefined;
  if (item && typeof item === "object") {
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "agent_message" && typeof item.text === "string") {
      return { agentMessage: item.text };
    }
    if (itemType === "command_execution" && typeof item.command === "string") {
      return { progressText: `exec: ${item.command}` };
    }
    if (itemType === "reasoning" && typeof item.text === "string") {
      return { progressText: item.text };
    }
  }

  // Legacy shape: {"id": "...", "msg": {"type": "...", ...}}
  const msg = event.msg as Record<string, unknown> | undefined;
  if (msg && typeof msg === "object") {
    const msgType = typeof msg.type === "string" ? msg.type : "";
    if (msgType === "session_configured" && typeof msg.session_id === "string") {
      return { sessionId: msg.session_id };
    }
    if (msgType === "agent_message" && typeof msg.message === "string") {
      return { agentMessage: msg.message };
    }
    if (msgType === "task_complete" && typeof msg.last_agent_message === "string") {
      return { agentMessage: msg.last_agent_message };
    }
    if (msgType === "exec_command_begin" && Array.isArray(msg.command)) {
      return { progressText: `exec: ${(msg.command as unknown[]).join(" ")}` };
    }
    if (msgType === "error" && typeof msg.message === "string") {
      return { errorText: msg.message };
    }
  }

  return {};
}

export function createCodexBackend(
  options: CodexBackendOptions = {}
): ICodingAgentBackend {
  return {
    name: "codex",

    async detect(): Promise<BackendAvailability> {
      const executablePath = resolveBackendExecutable(
        options.executablePath,
        "codex"
      );
      if (!executablePath) {
        return {
          name: "codex",
          available: false,
          problem:
            "codex executable not found. Install Codex CLI or set CODEX_CLI_PATH.",
        };
      }
      const version = await probeVersion(executablePath);
      if (version === null) {
        return {
          name: "codex",
          available: false,
          executablePath,
          problem: `"${executablePath} --version" failed — installation looks unhealthy.`,
        };
      }
      return { name: "codex", available: true, executablePath, version };
    },

    async start(
      context: BackendRunContext,
      task: string
    ): Promise<RunningAgent> {
      const availability = await this.detect();
      if (!availability.available || !availability.executablePath) {
        return unavailableRun(availability.problem ?? "codex is not available");
      }

      // workspace_write → isolated worktree cwd; external_action prepare →
      // plan-directory cwd. Both need writes inside cwd only.
      const sandbox =
        context.capability === "read_only" ? "read-only" : "workspace-write";
      const args = [
        "exec",
        "--json",
        "--sandbox",
        sandbox,
        "--cd",
        context.workspace,
        "--skip-git-repo-check",
      ];
      // `--search` only exists on the interactive TUI command; `codex exec`
      // (>= 0.144) takes the web-search capability as a config override.
      if (context.webResearch) {
        args.push("-c", "tools.web_search=true");
      }
      args.push("-"); // read the task prompt from stdin

      const logEvent = createArtifactLogger(context, "events.jsonl");
      const logStderr = createArtifactLogger(context, "stderr.log");

      let backendSessionId: string | undefined;
      let lastAgentMessage = "";
      let errorText = "";

      const proc = runSupervisedProcess({
        executable: availability.executablePath,
        args,
        cwd: context.workspace,
        stdin: task,
        timeoutMs: context.timeoutMs,
        maxOutputBytes: context.maxOutputBytes,
        onStdoutLine: (line) => {
          logEvent(line);
          const parsed = parseCodexEventLine(line);
          if (parsed.sessionId) {
            backendSessionId = parsed.sessionId;
          }
          if (parsed.agentMessage) {
            lastAgentMessage = parsed.agentMessage;
            context.onProgress(makeProgressEvent(parsed.agentMessage));
          }
          if (parsed.progressText) {
            context.onProgress(makeProgressEvent(parsed.progressText));
          }
          if (parsed.errorText) {
            errorText = parsed.errorText;
          }
        },
        onStderrLine: (line) => logStderr(line),
      });

      const wait: Promise<BackendRunOutcome> = proc.wait.then((outcome) => {
        if (outcome.error) {
          return failure(outcome.error, outcome.exitCode, backendSessionId);
        }
        if (outcome.cancelled) {
          return failure("cancelled", outcome.exitCode, backendSessionId);
        }
        if (outcome.timedOut) {
          return failure(
            "timed out before completing",
            outcome.exitCode,
            backendSessionId
          );
        }
        if (outcome.exitCode !== 0) {
          return failure(
            errorText || `codex exited with code ${outcome.exitCode}`,
            outcome.exitCode,
            backendSessionId
          );
        }
        return {
          ok: true,
          summary:
            lastAgentMessage ||
            "(codex completed without a final agent message)",
          exitCode: outcome.exitCode,
          backendSessionId,
        };
      });

      return { pid: proc.pid, wait, cancel: () => proc.cancel() };
    },
  };
}

function failure(
  error: string,
  exitCode: number | null,
  backendSessionId?: string
): BackendRunOutcome {
  return { ok: false, summary: "", exitCode, backendSessionId, error };
}

function unavailableRun(problem: string): RunningAgent {
  return {
    pid: undefined,
    wait: Promise.resolve({
      ok: false,
      summary: "",
      exitCode: null,
      error: problem,
    }),
    cancel: async () => undefined,
  };
}
