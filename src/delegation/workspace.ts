/**
 * Workspace validation — canonicalizes delegation workspaces and checks them
 * against the configured allowed roots.
 *
 * Phase C2a (docs/phase-c2-coding-agent-delegation.md §7). Every path is
 * canonicalized (symlinks/junctions resolved) before policy evaluation, so a
 * link inside an allowed root cannot escape it. On native Windows this layer
 * is the primary containment (§8.4) — it must stay safe even when the
 * backend's own sandbox enforces nothing.
 */

import * as fs from "fs";
import * as path from "path";

export interface CanonicalWorkspace {
  ok: true;
  /** Fully resolved real path of the workspace directory. */
  canonicalPath: string;
}

export interface WorkspaceError {
  ok: false;
  reason: string;
}

/**
 * Resolve a workspace path to its canonical real path.
 * Fails when the path does not exist or is not a directory.
 */
export function canonicalizeWorkspace(
  workspace: string
): CanonicalWorkspace | WorkspaceError {
  const resolved = path.resolve(workspace);

  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    return { ok: false, reason: `workspace does not exist: ${resolved}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return { ok: false, reason: `workspace is not accessible: ${resolved}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `workspace is not a directory: ${resolved}` };
  }

  return { ok: true, canonicalPath: realPath };
}

/**
 * True when `canonicalPath` is one of the allowed roots or strictly inside
 * one. Roots are canonicalized here too, so a configured root that is itself
 * a junction still compares correctly. Comparison is case-insensitive on
 * Windows.
 */
export function isInsideAllowedRoots(
  canonicalPath: string,
  allowedRoots: string[]
): boolean {
  const normalize = (p: string): string =>
    process.platform === "win32" ? p.toLowerCase() : p;

  const target = normalize(canonicalPath);

  for (const root of allowedRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync(path.resolve(root));
    } catch {
      continue; // configured root does not exist — never a match
    }
    const normalizedRoot = normalize(canonicalRoot);
    if (
      target === normalizedRoot ||
      target.startsWith(normalizedRoot + path.sep)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Create the per-task scratch workspace used by web-research tasks (§6.1):
 * an empty directory under the task's artifact dir, never a user-data root,
 * so no local file contents can travel with the queries.
 */
export function createScratchWorkspace(artifactDir: string): string {
  const scratch = path.join(artifactDir, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  return scratch;
}

// ── Workspace change detection (C2c §3.3) ────────────────────────────
//
// The prepare stage of an external_action task must not modify user data.
// Backend sandboxes are the first line, but on native Windows they may
// enforce nothing (§8.4), so the application snapshots the target workspace
// before prepare and rejects the plan if anything changed afterwards.

/** Beyond this many files the snapshot is marked incomplete and skipped. */
export const SNAPSHOT_MAX_FILES = 5000;

export interface WorkspaceSnapshot {
  /** False when the walk hit SNAPSHOT_MAX_FILES — verification is skipped. */
  complete: boolean;
  /** Relative file path → size and mtime. Symlinks are never followed. */
  entries: Map<string, { size: number; mtimeMs: number }>;
}

/** Record every file's size and mtime under `root`, bounded. */
export function snapshotWorkspace(root: string): WorkspaceSnapshot {
  const entries = new Map<string, { size: number; mtimeMs: number }>();
  let complete = true;

  const walk = (dir: string): void => {
    if (!complete) {
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — cannot be diffed either
    }
    for (const dirent of dirents) {
      if (!complete) {
        return;
      }
      const full = path.join(dir, dirent.name);
      if (dirent.isSymbolicLink()) {
        continue;
      }
      if (dirent.isDirectory()) {
        walk(full);
      } else if (dirent.isFile()) {
        if (entries.size >= SNAPSHOT_MAX_FILES) {
          complete = false;
          return;
        }
        try {
          const stat = fs.lstatSync(full);
          entries.set(path.relative(root, full), {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          // file vanished mid-walk — ignore
        }
      }
    }
  };

  walk(root);
  return { complete, entries };
}

/**
 * Compare the workspace against an earlier snapshot. Returns a bounded list
 * of changed/added/removed files, or null when the snapshot was incomplete
 * (verification not possible).
 */
export function findWorkspaceChanges(
  root: string,
  before: WorkspaceSnapshot,
  maxReported = 10
): string[] | null {
  if (!before.complete) {
    return null;
  }
  const after = snapshotWorkspace(root);
  if (!after.complete) {
    return null;
  }

  const changes: string[] = [];
  for (const [rel, stat] of after.entries) {
    const previous = before.entries.get(rel);
    if (!previous) {
      changes.push(`added: ${rel}`);
    } else if (previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs) {
      changes.push(`modified: ${rel}`);
    }
    if (changes.length >= maxReported) {
      return changes;
    }
  }
  for (const rel of before.entries.keys()) {
    if (!after.entries.has(rel)) {
      changes.push(`removed: ${rel}`);
      if (changes.length >= maxReported) {
        return changes;
      }
    }
  }
  return changes;
}
