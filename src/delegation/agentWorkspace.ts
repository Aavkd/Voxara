/**
 * Agent-owned workspaces — the deliverable spaces where delegated write
 * tasks run DIRECTLY, guarded by Git checkpoints instead of a worktree.
 *
 * Phase C2d (docs/phase-c2d-delegation-deliverables.md §4). The workspace
 * belongs to the agent, so isolation is replaced by versioning: the root is
 * bootstrapped as its own Git repository, dirty state is checkpointed before
 * a run, and a successful run's changes are committed with the task id. Every
 * git call is shell-free and bounded (C2 §8.4) via `runGit`.
 */

import * as fs from "fs";
import * as path from "path";
import {
  MAX_DIFF_SUMMARY_CHARS,
  MAX_PATCH_BYTES,
  runGit,
} from "./worktree";

/**
 * Commit identity for repository automation in agent-owned spaces — commits
 * must succeed regardless of the machine's global git configuration.
 */
const GIT_IDENTITY = [
  "-c", "user.name=Voxara",
  "-c", "user.email=voxara@localhost",
  "-c", "commit.gpgsign=false",
];

/** Bounded number of absolute file paths kept as the deliverable list. */
export const MAX_CHANGED_FILES = 50;

function normalizeCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Canonicalize a path that may not exist yet: realpath of its deepest
 * existing ancestor plus the remaining (already normalized) segments. A
 * symlink in the existing portion cannot escape containment checks this way.
 */
function canonicalizeForContainment(input: string): string {
  let current = path.resolve(input);
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    rest.unshift(path.basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(current);
  } catch {
    real = current;
  }
  return rest.length > 0 ? path.join(real, ...rest) : real;
}

/**
 * Return the canonical agent-owned root containing `target`, or null. Roots
 * are provisioned on demand (they are Voxara's own deliverable spaces), so a
 * configured root that does not exist yet is created here rather than
 * silently ignored. `target` itself does not need to exist.
 */
export function findAgentOwnedRoot(
  target: string,
  agentOwnedRoots: string[]
): string | null {
  const canonicalTarget = normalizeCase(canonicalizeForContainment(target));

  for (const root of agentOwnedRoots) {
    let canonicalRoot: string;
    try {
      fs.mkdirSync(path.resolve(root), { recursive: true });
      canonicalRoot = fs.realpathSync(path.resolve(root));
    } catch {
      continue;
    }
    const normalizedRoot = normalizeCase(canonicalRoot);
    if (
      canonicalTarget === normalizedRoot ||
      canonicalTarget.startsWith(normalizedRoot + path.sep)
    ) {
      return canonicalRoot;
    }
  }
  return null;
}

export interface ResolvedAgentWorkspace {
  ok: true;
  /** Canonical, existing workspace directory inside the agent-owned root. */
  canonicalPath: string;
}

export interface AgentWorkspaceError {
  ok: false;
  reason: string;
}

/**
 * Resolve (creating it if needed) a workspace path inside an agent-owned
 * root — e.g. `WORKSPACE\projects\myapp` for a new build (C2d §4.3). The
 * final realpath is re-checked against the root so a pre-existing symlink
 * cannot escape it.
 */
export function resolveAgentWorkspacePath(
  requested: string,
  agentRoot: string
): ResolvedAgentWorkspace | AgentWorkspaceError {
  const resolved = canonicalizeForContainment(requested);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot create workspace directory: ${message}` };
  }

  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return { ok: false, reason: `workspace is not accessible: ${resolved}` };
  }
  const normalizedRoot = normalizeCase(agentRoot);
  const normalizedReal = normalizeCase(real);
  if (
    normalizedReal !== normalizedRoot &&
    !normalizedReal.startsWith(normalizedRoot + path.sep)
  ) {
    return {
      ok: false,
      reason: `workspace resolves outside its agent-owned root: ${real}`,
    };
  }
  return { ok: true, canonicalPath: real };
}

export interface EnsuredRepo {
  ok: true;
  /** True when this call initialized the repository. */
  created: boolean;
}

/**
 * Bootstrap an agent-owned root as its own Git repository (C2d §4.1). A root
 * nested inside another repository (e.g. WORKSPACE inside the app repo)
 * still gets its OWN repo — presence of `<root>/.git` is the test, not the
 * upward repo search. Guarantees at least one commit so checkpoint diffs
 * always have a base.
 */
export function ensureAgentOwnedRepo(
  root: string
): EnsuredRepo | AgentWorkspaceError {
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot create agent-owned root: ${message}` };
  }

  let created = false;
  if (!fs.existsSync(path.join(root, ".git"))) {
    const init = runGit(root, ["init"]);
    if (!init.ok) {
      return {
        ok: false,
        reason: `git init failed in agent-owned root: ${init.stderr.trim().slice(0, 300)}`,
      };
    }
    created = true;
  }

  const head = runGit(root, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    // Empty initial commit: pre-existing files are absorbed by the next
    // labeled checkpoint, so the history says what actually happened.
    const commit = runGit(root, [
      ...GIT_IDENTITY,
      "commit",
      "--allow-empty",
      "-m",
      "voxara: initialize agent workspace",
    ]);
    if (!commit.ok) {
      return {
        ok: false,
        reason: `initial commit failed in agent-owned root: ${commit.stderr.trim().slice(0, 300)}`,
      };
    }
  }
  return { ok: true, created };
}

export interface WorkspaceCheckpoint {
  ok: true;
  /** HEAD after the checkpoint — the diff base for the run. */
  baseCommit: string;
}

/**
 * Absorb any dirty state into a labeled checkpoint commit before a run
 * (C2d §4.2), so the task's own diff is exactly what the task did and the
 * user always has a pre-task restore point.
 */
export function checkpointAgentWorkspace(
  root: string,
  taskId: string
): WorkspaceCheckpoint | AgentWorkspaceError {
  runGit(root, ["add", "-A"]);
  const status = runGit(root, ["status", "--porcelain"]);
  if (!status.ok) {
    return {
      ok: false,
      reason: `git status failed in agent-owned root: ${status.stderr.trim().slice(0, 300)}`,
    };
  }
  if (status.stdout.trim().length > 0) {
    const commit = runGit(root, [
      ...GIT_IDENTITY,
      "commit",
      "-m",
      `voxara: checkpoint before ${taskId}`,
    ]);
    if (!commit.ok) {
      return {
        ok: false,
        reason: `checkpoint commit failed: ${commit.stderr.trim().slice(0, 300)}`,
      };
    }
  }

  const head = runGit(root, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim().length === 0) {
    return { ok: false, reason: "cannot resolve HEAD after checkpoint." };
  }
  return { ok: true, baseCommit: head.stdout.trim() };
}

export interface DirectRunChanges {
  hasChanges: boolean;
  /** Bounded human-readable diffstat. */
  summary: string;
  /** Absolute paths of created/changed files (bounded deliverable list). */
  changedFiles: string[];
  /** Full patch audit artifact, when changes exist and the write succeeded. */
  patchFile: string | null;
  /** Commit that captured the changes, or null when nothing changed / commit failed. */
  taskCommit: string | null;
}

/**
 * Collect and commit what a direct run changed in the agent-owned root
 * (C2d §4.4). Unlike the worktree flow, the changes are already IN PLACE —
 * this records them (commit + patch audit artifact) and produces the
 * absolute-path deliverable list for the delivery.
 */
export function collectDirectRunChanges(
  root: string,
  baseCommit: string,
  artifactDir: string,
  taskId: string,
  taskText: string
): DirectRunChanges {
  runGit(root, ["add", "-A"]);

  const names = runGit(root, ["diff", "--name-status", baseCommit]);
  const changedRelative = names.ok
    ? names.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          // name-status: "M\tpath" or "R100\told\tnew" — the last field is
          // the path the file lives at now. Git prints forward slashes.
          const fields = line.split("\t");
          return fields[fields.length - 1].split("/").join(path.sep);
        })
        .slice(0, MAX_CHANGED_FILES)
    : [];

  if (changedRelative.length === 0) {
    return {
      hasChanges: false,
      summary: "no file changes",
      changedFiles: [],
      patchFile: null,
      taskCommit: null,
    };
  }

  const stat = runGit(root, ["diff", "--stat", baseCommit]);
  const rawSummary = (stat.ok ? stat.stdout : changedRelative.join("\n")).trim();
  const summary =
    rawSummary.length > MAX_DIFF_SUMMARY_CHARS
      ? `${rawSummary.slice(0, MAX_DIFF_SUMMARY_CHARS)}…`
      : rawSummary;

  let patchFile: string | null = null;
  const patch = runGit(root, ["diff", baseCommit]);
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

  const label = taskText.trim().replace(/\s+/g, " ").slice(0, 60);
  const commit = runGit(root, [
    ...GIT_IDENTITY,
    "commit",
    "-m",
    `${taskId}: ${label}`,
  ]);
  let taskCommit: string | null = null;
  if (commit.ok) {
    const head = runGit(root, ["rev-parse", "HEAD"]);
    taskCommit = head.ok ? head.stdout.trim() : null;
  }

  return {
    hasChanges: true,
    summary,
    changedFiles: changedRelative.map((rel) => path.join(root, rel)),
    patchFile,
    taskCommit,
  };
}
