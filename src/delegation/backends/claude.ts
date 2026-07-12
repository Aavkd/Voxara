/**
 * Claude Code backend adapter — non-interactive print mode with structured
 * stream-JSON output and application-owned tool allowlists.
 *
 * Phase C2a/C2b (docs/phase-c2-coding-agent-delegation.md §8.3). The
 * allowed-tools list is the containment: read/search tools for read_only
 * runs, plus WebSearch/WebFetch for web-research tasks (§6.1). For
 * workspace_write runs the edit tools and Bash are allowed so the agent can
 * implement and run tests (§6) — the run's cwd is the isolated disposable
 * worktree (§7), which is the primary containment on Windows (§8.4).
 * external_action PREPARE runs (C2c §3.3) get the write tools but no Bash:
 * their cwd is the plan directory, the deliverable is manifest.json plus
 * payload files, and nothing may execute before the user approves the plan.
 * Never passes --dangerously-skip-permissions or an equivalent.
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

export interface ClaudeBackendOptions {
  /** Explicit executable path (CLAUDE_CLI_PATH); PATH lookup otherwise. */
  executablePath?: string;
}

/** Maximum agent turns per delegated run (§8.3). */
export const CLAUDE_MAX_TURNS = 50;

const READ_ONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep"];
const WEB_RESEARCH_EXTRA_TOOLS = ["WebSearch", "WebFetch"];
const WRITE_ALLOWED_TOOLS = [
  ...READ_ONLY_ALLOWED_TOOLS,
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
];
const READ_ONLY_DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "KillShell",
];

/** Application-owned tool lists per capability (§8.3). */
export function claudeToolListsFor(context: {
  capability: string;
  webResearch: boolean;
}): { allowedTools: string[]; disallowedTools: string[] } {
  if (context.capability === "workspace_write") {
    return {
      allowedTools: WRITE_ALLOWED_TOOLS,
      disallowedTools: ["KillShell", ...WEB_RESEARCH_EXTRA_TOOLS],
    };
  }
  if (context.capability === "external_action") {
    // Prepare stage: write the manifest and payloads into the plan-dir cwd,
    // read the target workspace — but never execute anything (§3.3).
    return {
      allowedTools: [...READ_ONLY_ALLOWED_TOOLS, "Edit", "Write"],
      disallowedTools: [
        "Bash",
        "NotebookEdit",
        "KillShell",
        ...WEB_RESEARCH_EXTRA_TOOLS,
      ],
    };
  }
  if (context.webResearch) {
    return {
      allowedTools: [...READ_ONLY_ALLOWED_TOOLS, ...WEB_RESEARCH_EXTRA_TOOLS],
      disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
    };
  }
  return {
    allowedTools: READ_ONLY_ALLOWED_TOOLS,
    disallowedTools: [...READ_ONLY_DISALLOWED_TOOLS, ...WEB_RESEARCH_EXTRA_TOOLS],
  };
}

interface ParsedClaudeEvent {
  sessionId?: string;
  progressText?: string;
  resultText?: string;
  isErrorResult?: boolean;
}

/**
 * Parse one Claude Code stream-JSON line into the backend-neutral shape.
 * Malformed lines are reported as bounded progress, never thrown.
 */
export function parseClaudeEventLine(line: string): ParsedClaudeEvent {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return { progressText: "claude: unparsable event line" };
  }
  if (!event || typeof event !== "object") {
    return {};
  }

  const type = typeof event.type === "string" ? event.type : "";

  if (type === "system") {
    const sessionId =
      typeof event.session_id === "string" ? event.session_id : undefined;
    return sessionId ? { sessionId } : {};
  }

  if (type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          parts.push(`tool: ${b.name}`);
        }
      }
      if (parts.length > 0) {
        return { progressText: parts.join(" | ") };
      }
    }
    return {};
  }

  if (type === "result") {
    const resultText =
      typeof event.result === "string" ? event.result : "";
    const sessionId =
      typeof event.session_id === "string" ? event.session_id : undefined;
    return {
      resultText,
      sessionId,
      isErrorResult:
        event.is_error === true ||
        (typeof event.subtype === "string" && event.subtype !== "success"),
    };
  }

  return {};
}

export function createClaudeBackend(
  options: ClaudeBackendOptions = {}
): ICodingAgentBackend {
  return {
    name: "claude",

    async detect(): Promise<BackendAvailability> {
      const executablePath = resolveBackendExecutable(
        options.executablePath,
        "claude"
      );
      if (!executablePath) {
        return {
          name: "claude",
          available: false,
          problem:
            "claude executable not found. Install Claude Code or set CLAUDE_CLI_PATH.",
        };
      }
      const version = await probeVersion(executablePath);
      if (version === null) {
        return {
          name: "claude",
          available: false,
          executablePath,
          problem: `"${executablePath} --version" failed — installation looks unhealthy.`,
        };
      }
      return { name: "claude", available: true, executablePath, version };
    },

    async start(
      context: BackendRunContext,
      task: string
    ): Promise<RunningAgent> {
      const availability = await this.detect();
      if (!availability.available || !availability.executablePath) {
        return unavailableRun(availability.problem ?? "claude is not available");
      }

      const { allowedTools, disallowedTools } = claudeToolListsFor(context);

      // Task text travels via stdin; only trusted app-built flags on argv.
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        String(CLAUDE_MAX_TURNS),
        "--allowedTools",
        allowedTools.join(","),
        "--disallowedTools",
        disallowedTools.join(","),
      ];

      const logEvent = createArtifactLogger(context, "events.jsonl");
      const logStderr = createArtifactLogger(context, "stderr.log");

      let backendSessionId: string | undefined;
      let resultText = "";
      let isErrorResult = false;

      const proc = runSupervisedProcess({
        executable: availability.executablePath,
        args,
        cwd: context.workspace,
        stdin: task,
        timeoutMs: context.timeoutMs,
        maxOutputBytes: context.maxOutputBytes,
        onStdoutLine: (line) => {
          logEvent(line);
          const parsed = parseClaudeEventLine(line);
          if (parsed.sessionId) {
            backendSessionId = parsed.sessionId;
          }
          if (parsed.progressText) {
            context.onProgress(makeProgressEvent(parsed.progressText));
          }
          if (parsed.resultText !== undefined) {
            resultText = parsed.resultText;
            isErrorResult = parsed.isErrorResult === true;
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
        if (outcome.exitCode !== 0 || isErrorResult) {
          return failure(
            resultText || `claude exited with code ${outcome.exitCode}`,
            outcome.exitCode,
            backendSessionId
          );
        }
        return {
          ok: true,
          summary:
            resultText || "(claude completed without a final result message)",
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
