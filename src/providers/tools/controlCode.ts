/**
 * control_code tool — the D2 gated fallback: generated PowerShell or
 * browser-page JavaScript for what no typed intent expresses.
 *
 * Phase C3c1 (docs/phase-c3-computer-control.md §9.4). ALWAYS act_sensitive,
 * approved individually by trusted runtime state (even under `auto`, unless
 * CONTROL_CODE_AUTO=true).
 * The confirmation the model relays must include the model-written
 * `rationale` (a plain-language summary of what the code does). Journaled
 * with the full code text. PowerShell runs via the supervised process runner
 * (no shell interpolation, bounded output); browser_js runs in the active
 * tab through the paired extension.
 */

import * as os from "os";
import { loadControlCodeAuto, loadControlTrustLevel } from "../../config/loader";
import { BrowserExecutor, getBrowserExecutor } from "../../control/executor";
import { journalControl } from "../../control/journal";
import { evaluateControlIntent } from "../../control/policy";
import { fastLaneBlockedByPilot } from "../../control/pilotState";
import { ControlCodeLanguage } from "../../control/types";
import {
  ProcessOutcome,
  runSupervisedProcess,
} from "../../delegation/processRunner";
import { IToolProvider, ToolExecutionContext } from "./IToolProvider";

const CODE_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RESULT_CHARS = 4000;

/** Injectable so tests never spawn a real shell or need an extension. */
export interface ControlCodeRunners {
  runPowerShell?: (code: string) => Promise<{ stdout: string; stderr: string; outcome: ProcessOutcome }>;
  browserExecutor?: () => BrowserExecutor;
}

interface ControlCodeDependencies extends ControlCodeRunners {
  journal?: typeof journalControl;
  trustLevel?: () => ReturnType<typeof loadControlTrustLevel>;
  controlCodeAuto?: () => boolean;
}

export function createControlCodeTool(
  dependencies: ControlCodeDependencies = {}
): IToolProvider {
  const journal = dependencies.journal ?? journalControl;
  const trustLevel = dependencies.trustLevel ?? loadControlTrustLevel;
  const runPowerShell = dependencies.runPowerShell ?? defaultPowerShellRunner;

  return {
    name: "control_code",
    description:
      "Fallback for what no typed intent (browser_act / desktop_act) can " +
      "express: run generated code. language=powershell runs a PowerShell " +
      "script on the machine; language=browser_js runs JavaScript in the " +
      "active Chrome tab. Prefer the typed intents — use this only when they " +
      "genuinely cannot do it. ALWAYS requires the user's explicit yes: put a " +
      "clear, plain-language summary of exactly what the code does in " +
      "`rationale` (it is shown to the user). If the result starts with " +
      "action_blocked, STOP: the runtime resumes that exact call after the " +
      "user's explicit yes; never retry it yourself.",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["powershell", "browser_js"],
          description: "powershell = run on the machine; browser_js = run in the active tab.",
        },
        code: {
          type: "string",
          description: "The script to run. Keep it minimal and single-purpose.",
        },
        rationale: {
          type: "string",
          description:
            "Plain-language summary of what the code does and why — shown VERBATIM " +
            "to the user for approval. Be concrete about any side effect.",
        },
      },
      required: ["language", "code", "rationale"],
    },
    async execute(
      params: Record<string, unknown>,
      _sandboxDir: string,
      context?: ToolExecutionContext
    ): Promise<unknown> {
      const language: ControlCodeLanguage | undefined =
        params.language === "powershell"
          ? "powershell"
          : params.language === "browser_js"
            ? "browser_js"
            : undefined;
      if (!language) {
        return 'error: language must be "powershell" or "browser_js"';
      }
      const code = typeof params.code === "string" ? params.code : "";
      const rationale = typeof params.rationale === "string" ? params.rationale.trim() : "";
      if (!code.trim()) {
        return "error: control_code requires non-empty code";
      }
      if (!rationale) {
        return "error: control_code requires a rationale (shown to the user for approval)";
      }
      const lane = context?.controlLane;
      const pilotBlock = fastLaneBlockedByPilot(lane);
      if (pilotBlock) {
        return pilotBlock;
      }
      // Approval is trusted application state, never a model-generated param.
      const confirmed = context?.controlApproved === true;
      const sessionId = context?.sessionId || "unscoped";

      const decision = evaluateControlIntent({
        intent: { tool: "control_code" },
        trustLevel: trustLevel(),
        sessionId,
        confirmed,
        controlCodeAuto: (dependencies.controlCodeAuto ?? loadControlCodeAuto)(),
      });

      const target = `${language}: ${rationale}`;
      const journalCode = `${rationale}\n---\n${code}`;

      if (decision.outcome !== "allowed") {
        journal({
          sessionId,
          lane: lane ?? "fast",
          intent: `control_code:${language}`,
          target: journalCode,
          policyDecision: decision.outcome,
          outcome: "blocked",
        });
        return (
          `action_blocked (${decision.outcome}) — ${language} code. ` +
          `Rationale to show the user: ${rationale}. ${decision.reason}`
        );
      }

      try {
        const result =
          language === "powershell"
            ? await runPowerShellCode(code, runPowerShell)
            : await runBrowserJs(code, dependencies.browserExecutor ?? getBrowserExecutor);
        journal({
          sessionId,
          lane: lane ?? "fast",
          intent: `control_code:${language}`,
          target: journalCode,
          policyDecision: decision.outcome,
          outcome: "success",
        });
        return result;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        journal({
          sessionId,
          lane: lane ?? "fast",
          intent: `control_code:${language}`,
          target: journalCode,
          policyDecision: decision.outcome,
          outcome: "error",
          error: message,
        });
        return `error: control_code (${language}) failed: ${message}`;
      }
    },
  };
}

async function runPowerShellCode(
  code: string,
  run: NonNullable<ControlCodeDependencies["runPowerShell"]>
): Promise<string> {
  const { stdout, stderr, outcome } = await run(code);
  return formatProcessResult(stdout, stderr, outcome);
}

/**
 * Run generated PowerShell through the supervised process runner: the script
 * travels via stdin (never the command line), output is byte-bounded, and the
 * process tree is killed on timeout — the same discipline as the delegation
 * runner (§9.4 reuse).
 */
async function defaultPowerShellRunner(
  code: string
): Promise<{ stdout: string; stderr: string; outcome: ProcessOutcome }> {
  if (process.platform !== "win32") {
    throw new Error("PowerShell control_code is available on Windows only");
  }
  let stdout = "";
  let stderr = "";
  const supervised = runSupervisedProcess({
    executable: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
    cwd: os.tmpdir(),
    stdin: code,
    timeoutMs: CODE_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    onStdoutLine: (line) => {
      stdout += `${line}\n`;
    },
    onStderrLine: (line) => {
      stderr += `${line}\n`;
    },
  });
  const outcome = await supervised.wait;
  return { stdout, stderr, outcome };
}

function formatProcessResult(
  stdout: string,
  stderr: string,
  outcome: ProcessOutcome
): string {
  if (outcome.error) {
    return `control_code could not run: ${outcome.error}`;
  }
  const parts: string[] = [];
  if (outcome.timedOut) {
    parts.push("(timed out and was terminated)");
  }
  parts.push(`exit code: ${outcome.exitCode ?? "unknown"}`);
  if (stdout.trim()) {
    parts.push(`stdout:\n${clip(stdout.trim())}`);
  }
  if (stderr.trim()) {
    parts.push(`stderr:\n${clip(stderr.trim())}`);
  }
  if (!stdout.trim() && !stderr.trim()) {
    parts.push("(no output)");
  }
  return parts.join("\n");
}

async function runBrowserJs(
  code: string,
  executorFactory: () => BrowserExecutor
): Promise<string> {
  const result = await executorFactory().execJs(code);
  return clip(typeof result === "string" ? result : JSON.stringify(result));
}

function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text;
}

export default createControlCodeTool();
