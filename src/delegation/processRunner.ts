/**
 * Process Runner — supervised child-process spawning for delegated
 * coding-agent runs.
 *
 * Phase C2a (docs/phase-c2-coding-agent-delegation.md §8.4):
 *  - argument-array invocation with shell:false — never a concatenated
 *    shell command;
 *  - minimal child environment (no secrets copied in);
 *  - stdout/stderr captured separately, parsed incrementally as lines, and
 *    byte-limited;
 *  - overall timeout and idle timeout;
 *  - cancellation terminates the complete child process tree (taskkill /T /F
 *    on Windows);
 *  - malformed output or a non-zero exit produces a bounded diagnostic,
 *    never a crash of the conversational session.
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";

export interface ProcessRunOptions {
  /** Executable path or name. `.js` files run via the current Node binary. */
  executable: string;
  args: string[];
  cwd: string;
  /** Extra environment variables layered over the minimal base env. */
  env?: Record<string, string>;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  timeoutMs: number;
  /** Kill the child when no output arrives for this long (0 = disabled). */
  idleTimeoutMs?: number;
  /** Per-stream cap; output beyond it is dropped and flagged truncated. */
  maxOutputBytes: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface ProcessOutcome {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Spawn-level failure (executable missing, etc.). */
  error?: string;
}

export interface SupervisedProcess {
  pid: number | undefined;
  wait: Promise<ProcessOutcome>;
  /** Terminate the full process tree. Resolves once the child has exited. */
  cancel(): Promise<void>;
}

/**
 * Environment variables copied from the parent so child processes can start
 * at all. Everything else — API keys in particular — is withheld; backend
 * CLIs own their credentials via their own auth stores (§13).
 */
const BASE_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "USERNAME",
  "LANG",
  "LC_ALL",
];

function buildMinimalEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...(extra ?? {}) };
}

/**
 * Resolve how to actually spawn the executable without a shell:
 *  - `.js` files run through the current Node binary (used by tests and any
 *    JS-entry installation);
 *  - `.cmd`/`.bat` shims (npm global installs on Windows) run through
 *    cmd.exe. Only trusted application-constructed flags may appear in args;
 *    untrusted task text must travel via stdin.
 */
function resolveSpawnTarget(
  executable: string,
  args: string[]
): { command: string; args: string[] } {
  const ext = path.extname(executable).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return { command: process.execPath, args: [executable, ...args] };
  }
  if (process.platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    const comspec = process.env.COMSPEC || "cmd.exe";
    return { command: comspec, args: ["/d", "/s", "/c", executable, ...args] };
  }
  return { command: executable, args };
}

/** Split a stream into lines, keeping a bounded carry for partial lines. */
class LineSplitter {
  private carry = "";
  private bytesSeen = 0;
  truncated = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onLine?: (line: string) => void
  ) {}

  push(chunk: Buffer): void {
    this.bytesSeen += chunk.length;
    if (this.truncated) {
      return;
    }
    if (this.bytesSeen > this.maxBytes) {
      this.truncated = true;
      this.flush();
      return;
    }

    this.carry += chunk.toString("utf-8");
    let newlineIndex = this.carry.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.carry.slice(0, newlineIndex).replace(/\r$/, "");
      this.carry = this.carry.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.onLine?.(line);
      }
      newlineIndex = this.carry.indexOf("\n");
    }
  }

  flush(): void {
    const line = this.carry.trim();
    this.carry = "";
    if (line.length > 0) {
      this.onLine?.(line);
    }
  }
}

/**
 * Spawn a supervised child process. Never throws — spawn failures surface in
 * the resolved ProcessOutcome.
 */
export function runSupervisedProcess(options: ProcessRunOptions): SupervisedProcess {
  const target = resolveSpawnTarget(options.executable, options.args);

  let child: ChildProcess;
  try {
    child = spawn(target.command, target.args, {
      cwd: options.cwd,
      env: buildMinimalEnv(options.env),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      pid: undefined,
      wait: Promise.resolve({
        exitCode: null,
        timedOut: false,
        cancelled: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        error: `failed to spawn "${options.executable}": ${message}`,
      }),
      cancel: async () => undefined,
    };
  }

  let timedOut = false;
  let cancelled = false;
  let spawnError: string | undefined;

  const stdout = new LineSplitter(options.maxOutputBytes, options.onStdoutLine);
  const stderr = new LineSplitter(options.maxOutputBytes, options.onStderrLine);

  child.stdout?.on("data", (chunk: Buffer) => {
    resetIdleTimer();
    stdout.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    resetIdleTimer();
    stderr.push(chunk);
  });

  if (options.stdin !== undefined) {
    child.stdin?.write(options.stdin);
  }
  child.stdin?.end();
  // A closed/broken stdin pipe (e.g. child exits early) must not crash us.
  child.stdin?.on("error", () => undefined);

  const killTree = (): void => {
    if (child.pid === undefined || child.exitCode !== null) {
      return;
    }
    if (process.platform === "win32") {
      // taskkill /T terminates the whole tree; detached from our stdio.
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        child.kill("SIGKILL");
      }
    } else {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  };

  const overallTimer = setTimeout(() => {
    timedOut = true;
    killTree();
  }, options.timeoutMs);

  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdleTimer = (): void => {
    if (!options.idleTimeoutMs || options.idleTimeoutMs <= 0) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.idleTimeoutMs);
  };
  resetIdleTimer();

  const wait = new Promise<ProcessOutcome>((resolve) => {
    let settled = false;
    const settle = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(overallTimer);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      stdout.flush();
      stderr.flush();
      resolve({
        exitCode,
        timedOut,
        cancelled,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        error: spawnError,
      });
    };

    child.on("error", (err) => {
      spawnError = `failed to run "${options.executable}": ${err.message}`;
      // A failed spawn (ENOENT) emits "error" without a subsequent "close".
      setImmediate(() => settle(null));
    });

    child.on("close", (code) => settle(code));
  });

  return {
    pid: child.pid,
    wait,
    cancel: async (): Promise<void> => {
      cancelled = true;
      killTree();
      await wait;
    },
  };
}
