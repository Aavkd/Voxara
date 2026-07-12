/**
 * Shared backend-adapter helpers: executable resolution, version detection,
 * secret redaction, progress bounding, and raw event logging.
 *
 * Phase C2a (docs/phase-c2-coding-agent-delegation.md §8.4).
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { runSupervisedProcess } from "../processRunner";
import { BackendRunContext, DelegationProgressEvent } from "../types";

/** Progress lines shown to the model/UI are clipped to this length. */
export const MAX_PROGRESS_TEXT_CHARS = 240;

/**
 * Resolve a backend executable: an explicitly configured path wins; otherwise
 * look the name up on PATH (`where` on Windows, `which` elsewhere). Returns
 * null when nothing is found.
 */
export function resolveBackendExecutable(
  configuredPath: string | undefined,
  name: string
): string | null {
  if (configuredPath && configuredPath.trim().length > 0) {
    const resolved = path.resolve(configuredPath.trim());
    return fs.existsSync(resolved) ? resolved : null;
  }

  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(lookup, [name], {
      encoding: "utf-8",
      shell: false,
      windowsHide: true,
      timeout: 5000,
    });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    const candidates = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (candidates.length === 0) {
      return null;
    }

    if (process.platform === "win32") {
      // `where` often lists an extensionless POSIX shim (e.g. npm's own
      // launcher script) before the .cmd/.exe shim. CreateProcess cannot run
      // an extensionless file directly, so rank by extension and skip those.
      const byExtension = (ext: string): string | undefined =>
        candidates.find((c) => c.toLowerCase().endsWith(ext));
      return (
        byExtension(".exe") ??
        byExtension(".cmd") ??
        byExtension(".bat") ??
        candidates[0]
      );
    }

    return candidates[0];
  } catch {
    return null;
  }
}

/**
 * Run `<executable> --version` with a short budget and return the first
 * output line, or null when the probe fails. Never starts a paid task.
 */
export async function probeVersion(executable: string): Promise<string | null> {
  let firstLine: string | null = null;
  const proc = runSupervisedProcess({
    executable,
    args: ["--version"],
    cwd: process.cwd(),
    timeoutMs: 10000,
    maxOutputBytes: 64 * 1024,
    onStdoutLine: (line) => {
      if (firstLine === null) {
        firstLine = line.trim();
      }
    },
  });
  const outcome = await proc.wait;
  if (outcome.error || outcome.exitCode !== 0) {
    return null;
  }
  return firstLine;
}

/**
 * Redact likely secrets before any text is logged, persisted, or surfaced
 * (§8.4). Heuristic, deliberately aggressive.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization|bearer)\s*[=:]\s*)\S+/gi,
      "$1[redacted]"
    )
    .replace(/\b(sk|pk|ghp|gho|xoxb|xoxp)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}

/** Clip, redact, and timestamp a progress line. */
export function makeProgressEvent(text: string): DelegationProgressEvent {
  const clean = redactSecrets(text.trim());
  return {
    at: new Date().toISOString(),
    text:
      clean.length > MAX_PROGRESS_TEXT_CHARS
        ? `${clean.slice(0, MAX_PROGRESS_TEXT_CHARS)}…`
        : clean,
  };
}

/**
 * Append-only raw event logger in the task's artifact directory. Failures to
 * log never fail the run.
 */
export function createArtifactLogger(
  context: BackendRunContext,
  fileName: string
): (line: string) => void {
  const filePath = path.join(context.artifactDir, fileName);
  try {
    fs.mkdirSync(context.artifactDir, { recursive: true });
  } catch {
    return () => undefined;
  }
  return (line: string): void => {
    try {
      fs.appendFileSync(filePath, redactSecrets(line) + "\n", "utf-8");
    } catch {
      // logging must never break the run
    }
  };
}
