/**
 * Git worktree isolation — write-capable delegated tasks run in a temporary
 * detached worktree, never against the user's main tree.
 *
 * Phase C2b (docs/phase-c2-coding-agent-delegation.md §7, §17). On success
 * the service reports the diff and keeps a patch artifact; merging or
 * applying the changes is a separate user decision. All git invocations use
 * argument arrays with shell:false (§8.4).
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_BUFFER_BYTES = 16 * 1024 * 1024;
/** Bounded diff summary kept in the task record / deliveries. */
export const MAX_DIFF_SUMMARY_CHARS = 800;
/** Full patch artifact cap — larger diffs are truncated with a marker. */
export const MAX_PATCH_BYTES = 5 * 1024 * 1024;

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Bounded, shell-free git invocation shared by the isolation helpers. */
export function runGit(cwd: string, args: string[]): GitResult {
  try {
    const result = spawnSync("git", args, {
      cwd,
      // Explicit so callers (and tests) that mutate their process.env view
      // are honored even when that view is a sandboxed copy.
      env: process.env,
      encoding: "utf-8",
      shell: false,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_BUFFER_BYTES,
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (err: unknown) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve the Git repository root containing `workspace`, or null when the
 * workspace is not inside a Git working tree.
 */
export function getGitRepoRoot(workspace: string): string | null {
  const result = runGit(workspace, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) {
    return null;
  }
  const top = result.stdout.trim();
  if (!top) {
    return null;
  }
  try {
    return fs.realpathSync(path.resolve(top));
  } catch {
    return null;
  }
}

export interface TaskWorktree {
  ok: true;
  /** Canonical path of the created worktree directory. */
  worktreeDir: string;
  /** Commit the worktree was created from — the diff base. */
  baseCommit: string;
}

export interface WorktreeCreationError {
  ok: false;
  reason: string;
}

/**
 * Create a detached worktree for one task under `parentDir` (the task's
 * artifact directory), based on the repository's current HEAD. Detached — no
 * branch is created in the user's repository; the reviewable artifact is the
 * patch collected after the run.
 */
export function createTaskWorktree(
  repoRoot: string,
  parentDir: string
): TaskWorktree | WorktreeCreationError {
  const head = runGit(repoRoot, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return {
      ok: false,
      reason:
        "the repository has no commit yet (git rev-parse HEAD failed) — " +
        "make an initial commit before delegating a write task.",
    };
  }
  const baseCommit = head.stdout.trim();

  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot create worktree parent: ${message}` };
  }

  const worktreeDir = path.join(parentDir, "worktree");
  const add = runGit(repoRoot, [
    "worktree",
    "add",
    "--detach",
    worktreeDir,
    baseCommit,
  ]);
  if (!add.ok) {
    return {
      ok: false,
      reason: `git worktree add failed: ${add.stderr.trim().slice(0, 300)}`,
    };
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(worktreeDir);
  } catch {
    canonical = worktreeDir;
  }
  return { ok: true, worktreeDir: canonical, baseCommit };
}

export interface WorktreeChanges {
  hasChanges: boolean;
  /** Bounded human-readable summary (diffstat). */
  summary: string;
  /** name-status lines, bounded. */
  changedFiles: string[];
  /** Full patch artifact path, when changes exist and the write succeeded. */
  patchFile: string | null;
}

/**
 * Collect what the delegated run changed in its worktree relative to the
 * base commit. The worktree is disposable, so everything is staged first
 * (`git add -A`) to make newly created files visible to the diff. The full
 * patch is saved to `<artifactDir>/changes.patch`.
 */
export function collectWorktreeChanges(
  worktreeDir: string,
  baseCommit: string,
  artifactDir: string
): WorktreeChanges {
  runGit(worktreeDir, ["add", "-A"]);

  const names = runGit(worktreeDir, ["diff", "--name-status", baseCommit]);
  const changedFiles = names.ok
    ? names.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 100)
    : [];

  if (changedFiles.length === 0) {
    return {
      hasChanges: false,
      summary: "no file changes",
      changedFiles: [],
      patchFile: null,
    };
  }

  const stat = runGit(worktreeDir, ["diff", "--stat", baseCommit]);
  const rawSummary = (stat.ok ? stat.stdout : changedFiles.join("\n")).trim();
  const summary =
    rawSummary.length > MAX_DIFF_SUMMARY_CHARS
      ? `${rawSummary.slice(0, MAX_DIFF_SUMMARY_CHARS)}…`
      : rawSummary;

  let patchFile: string | null = null;
  const patch = runGit(worktreeDir, ["diff", baseCommit]);
  if (patch.ok) {
    const target = path.join(artifactDir, "changes.patch");
    const body =
      patch.stdout.length > MAX_PATCH_BYTES
        ? patch.stdout.slice(0, MAX_PATCH_BYTES) +
          "\n# [patch truncated at size limit]\n"
        : patch.stdout;
    try {
      fs.writeFileSync(target, body, "utf-8");
      patchFile = target;
    } catch {
      patchFile = null;
    }
  }

  return { hasChanges: true, summary, changedFiles, patchFile };
}

/**
 * Remove a task worktree and its registration in the main repository.
 * Never throws — pruning must not break startup or artifact retention.
 */
export function removeTaskWorktree(
  repoRoot: string,
  worktreeDir: string
): void {
  const removed = runGit(repoRoot, [
    "worktree",
    "remove",
    "--force",
    worktreeDir,
  ]);
  if (!removed.ok) {
    try {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    runGit(repoRoot, ["worktree", "prune"]);
  }
}
