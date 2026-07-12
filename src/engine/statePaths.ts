/**
 * State directory resolution — engine state (tasks, deliveries, delegation
 * artifacts) lives under ~/.llmtest/state/, beside the session files.
 *
 * Phase C2a (docs/phase-c2-coding-agent-delegation.md §10, shared with the
 * C1 delivery-queue design in docs/phase-c1-reminders-continuity.md §3).
 *
 * Plain JSON, human-readable, safe to delete: deleting loses pending tasks
 * and deliveries but never breaks the app (same degrade-to-empty convention
 * as memoryStore).
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

export interface StatePaths {
  root: string;
  tasksFile: string;
  deliveryFile: string;
  delegationDir: string;
}

/**
 * Resolve the state directory paths.
 * Order: explicit argument, LLMTEST_STATE_DIR, then ~/.llmtest/state.
 */
export function getStatePaths(baseDir?: string): StatePaths {
  const root = path.resolve(
    baseDir ||
      process.env.LLMTEST_STATE_DIR ||
      path.join(os.homedir(), ".llmtest", "state")
  );

  return {
    root,
    tasksFile: path.join(root, "tasks.json"),
    deliveryFile: path.join(root, "delivery.json"),
    delegationDir: path.join(root, "delegation"),
  };
}

/** Create the state directory if missing. Idempotent. */
export function ensureStateDir(baseDir?: string): StatePaths {
  const paths = getStatePaths(baseDir);
  if (!fs.existsSync(paths.root)) {
    fs.mkdirSync(paths.root, { recursive: true });
  }
  return paths;
}

/** Rename errors worth retrying: on Windows an antivirus or indexer briefly
 * holding the target/temp file surfaces as one of these. */
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_MAX_ATTEMPTS = 5;

/**
 * Atomic write shared by the state stores: temp file in the same directory,
 * then rename over the target. The rename is retried with a short backoff on
 * transient Windows sharing violations, so a passing scan never silently
 * loses a task or delivery update.
 */
export function atomicWriteFileSync(targetFile: string, content: string): void {
  const tmpFile = path.join(
    path.dirname(targetFile),
    `.${path.basename(targetFile)}-${process.pid}-${crypto.randomBytes(3).toString("hex")}.tmp`
  );
  fs.writeFileSync(tmpFile, content, "utf-8");

  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmpFile, targetFile);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= RENAME_MAX_ATTEMPTS || !RETRYABLE_RENAME_CODES.has(code)) {
        try {
          fs.rmSync(tmpFile, { force: true });
        } catch {
          // leave the temp file behind rather than mask the original error
        }
        throw err;
      }
      sleepSync(10 * attempt);
    }
  }
}

/** Synchronous bounded sleep for the rename retry (blocks ≤ ~150 ms total). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // busy-wait fallback, bounded by `ms`
    }
  }
}
