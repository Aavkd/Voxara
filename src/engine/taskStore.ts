/**
 * Task Store — persistent background-task records in ~/.llmtest/state/tasks.json.
 *
 * Phase C2a (docs/phase-c2-coding-agent-delegation.md §10). This is the shared
 * engine primitive that phase C1's background dispatch also reuses: a generic
 * task record with a `kind` discriminator, atomic writes (temp file + rename),
 * and serialized in-process updates (all operations are synchronous).
 *
 * tasks.json keeps only bounded summaries; raw event logs and artifacts live
 * in a per-task directory referenced by `artifactDir`.
 */

import * as fs from "fs";
import * as crypto from "crypto";
import { atomicWriteFileSync, ensureStateDir, getStatePaths } from "./statePaths";

export type TaskStatus =
  | "queued"
  | "pending_approval"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Bounded progress entry kept inside the task record. */
export interface TaskProgressEntry {
  at: string;
  text: string;
}

/**
 * A persisted background task. The core fields follow the C1 `tasks.json`
 * schema; delegation (kind "coding_agent") extends it with the C2 §10 fields.
 */
export interface TaskRecord {
  id: string;
  kind: string; // "coding_agent" | future background tool kinds
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  sessionId: string | null;
  /** PID of the Voxara process that owns the run — used by the startup sweep. */
  ownerPid: number | null;

  // ── coding_agent extension (C2 §10) ────────────────────────────────
  backend?: string;
  task?: string;
  workspace?: string;
  capability?: string;
  webResearch?: boolean;
  execution?: string;
  backendSessionId?: string | null;
  pid?: number | null;
  progress?: TaskProgressEntry[];
  result?: string | null;
  error?: string | null;
  approvalRequest?: string | null;
  artifactDir?: string | null;
  /** Id of the original task when this task is an explicit retry. */
  retryOf?: string | null;

  // ── workspace_write isolation (C2b §7, C2d §4) ─────────────────────
  /** Git repository root the run was based on (worktree source or agent-owned root). */
  repoRoot?: string | null;
  /** Isolated detached worktree the run executed in (worktree runs only). */
  worktreeDir?: string | null;
  /** Commit the run started from — the diff base. */
  baseCommit?: string | null;
  /** Bounded diffstat of what the run changed. */
  diffSummary?: string | null;
  /** Full patch artifact (review artifact for worktree runs, audit for direct runs). */
  patchFile?: string | null;
  /** How the write ran: directly in an agent-owned workspace, or in a worktree (C2d §3). */
  runMode?: "direct" | "worktree" | null;
  /** Commit that captured a direct run's changes in the agent-owned repo. */
  taskCommit?: string | null;
  /** Absolute paths of files the run created/changed (bounded deliverable list, C2d §9). */
  changedFiles?: string[] | null;

  // ── external_action prepare/apply (C2c §3.3) ───────────────────────
  /** Which stage a running external_action task is in. */
  stage?: "prepare" | "apply" | null;
  /** Plan directory the prepare stage wrote its manifest and payloads to. */
  planDir?: string | null;
  /** Validated manifest.json path awaiting (or granted) approval. */
  manifestFile?: string | null;
  /** Bounded human-readable plan summary shown for approval. */
  manifestSummary?: string | null;
  /** When delegate_approve granted the apply stage. */
  approvedAt?: string | null;
}

/** Maximum progress entries retained per task (bounded summaries only). */
export const TASK_MAX_PROGRESS_ENTRIES = 30;

/** Generate a task id: task-<yyyymmdd>-<6 hex chars>. */
export function newTaskId(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const suffix = crypto.randomBytes(3).toString("hex");
  return `task-${y}${m}${d}-${suffix}`;
}

/**
 * Read every task record. Missing or corrupted files degrade to an empty
 * list — the store must never break the app.
 */
export function listTasks(baseDir?: string): TaskRecord[] {
  const { tasksFile } = getStatePaths(baseDir);
  if (!fs.existsSync(tasksFile)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(tasksFile, "utf-8"));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (t): t is TaskRecord =>
        !!t && typeof t.id === "string" && typeof t.status === "string"
    );
  } catch {
    return [];
  }
}

/** Return one task by id, or null. */
export function getTask(id: string, baseDir?: string): TaskRecord | null {
  return listTasks(baseDir).find((t) => t.id === id) ?? null;
}

/** Persist a new task record. */
export function createTask(record: TaskRecord, baseDir?: string): TaskRecord {
  const tasks = listTasks(baseDir);
  tasks.push(record);
  writeTasks(tasks, baseDir);
  return record;
}

/**
 * Apply a partial update to a task and persist atomically.
 * Returns the updated record, or null when the id is unknown.
 */
export function updateTask(
  id: string,
  patch: Partial<TaskRecord>,
  baseDir?: string
): TaskRecord | null {
  const tasks = listTasks(baseDir);
  const index = tasks.findIndex((t) => t.id === id);
  if (index === -1) {
    return null;
  }

  const updated: TaskRecord = { ...tasks[index], ...patch, id };
  tasks[index] = updated;
  writeTasks(tasks, baseDir);
  return updated;
}

/**
 * Append a bounded progress entry to a task (oldest entries are dropped
 * beyond TASK_MAX_PROGRESS_ENTRIES).
 */
export function appendTaskProgress(
  id: string,
  text: string,
  baseDir?: string
): void {
  const task = getTask(id, baseDir);
  if (!task) {
    return;
  }
  const progress = [...(task.progress ?? []), { at: new Date().toISOString(), text }];
  updateTask(
    id,
    { progress: progress.slice(-TASK_MAX_PROGRESS_ENTRIES) },
    baseDir
  );
}

/** True when a PID belongs to a live process. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Startup sweep: any `running` task whose owning process died lost its child.
 * Mark each `interrupted` and return them so the caller can queue exactly one
 * failure delivery per task (C2 §10). Tasks owned by another live Voxara
 * process are left alone.
 */
export function sweepInterruptedTasks(
  currentPid: number,
  baseDir?: string,
  isAlive: (pid: number) => boolean = isPidAlive
): TaskRecord[] {
  const tasks = listTasks(baseDir);
  const interrupted: TaskRecord[] = [];
  let changed = false;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const orphaned =
      task.ownerPid === null ||
      (task.ownerPid !== currentPid && !isAlive(task.ownerPid));
    if (task.status === "running" && orphaned) {
      tasks[i] = {
        ...task,
        status: "interrupted",
        completedAt: new Date().toISOString(),
        error: task.error ?? "interrupted: the owning process exited before the task completed",
      };
      interrupted.push(tasks[i]);
      changed = true;
    }
  }

  if (changed) {
    writeTasks(tasks, baseDir);
  }
  return interrupted;
}

/** Atomic write: temp file then rename, with transient-error retry. */
function writeTasks(tasks: TaskRecord[], baseDir?: string): void {
  const { tasksFile } = ensureStateDir(baseDir);
  atomicWriteFileSync(tasksFile, JSON.stringify(tasks, null, 2));
}
