/**
 * Task store + delivery queue tests (phase C2a — spec §15 "Persistence").
 * All file operations run against a temp state directory.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createTask,
  getTask,
  listTasks,
  newTaskId,
  sweepInterruptedTasks,
  updateTask,
  appendTaskProgress,
  TaskRecord,
  TASK_MAX_PROGRESS_ENTRIES,
} from "../src/engine/taskStore";
import {
  drainPendingDeliveries,
  listDeliveries,
  markDeliveriesDelivered,
  peekPendingDeliveries,
  queueDelivery,
} from "../src/engine/deliveryQueue";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "voxara-state-"));
}

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: newTaskId(),
    kind: "coding_agent",
    status: "running",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    sessionId: null,
    ownerPid: process.pid,
    ...overrides,
  };
}

describe("taskStore", () => {
  test("task ids follow the task-<yyyymmdd>-<hex> convention", () => {
    expect(newTaskId(new Date("2026-07-12T10:00:00Z"))).toMatch(
      /^task-20260712-[0-9a-f]{6}$/
    );
  });

  test("create / get / update round-trip", () => {
    const dir = tempDir();
    const task = createTask(baseTask({ task: "inspect repo" }), dir);

    expect(getTask(task.id, dir)?.task).toBe("inspect repo");

    const updated = updateTask(task.id, { status: "done", result: "ok" }, dir);
    expect(updated?.status).toBe("done");
    expect(getTask(task.id, dir)?.result).toBe("ok");
  });

  test("updateTask on unknown id returns null", () => {
    const dir = tempDir();
    expect(updateTask("task-unknown", { status: "done" }, dir)).toBeNull();
  });

  test("progress entries are bounded", () => {
    const dir = tempDir();
    const task = createTask(baseTask(), dir);
    for (let i = 0; i < TASK_MAX_PROGRESS_ENTRIES + 10; i++) {
      appendTaskProgress(task.id, `step ${i}`, dir);
    }
    const progress = getTask(task.id, dir)?.progress ?? [];
    expect(progress.length).toBe(TASK_MAX_PROGRESS_ENTRIES);
    expect(progress[progress.length - 1].text).toBe(
      `step ${TASK_MAX_PROGRESS_ENTRIES + 9}`
    );
  });

  test("corrupted tasks.json degrades to empty, never throws", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "tasks.json"), "{not json", "utf-8");
    expect(listTasks(dir)).toEqual([]);
  });

  test("startup sweep marks orphaned running tasks interrupted exactly once", () => {
    const dir = tempDir();
    const dead = createTask(baseTask({ ownerPid: 999999 }), dir);
    const ours = createTask(baseTask({ ownerPid: process.pid }), dir);
    const done = createTask(baseTask({ status: "done", ownerPid: 999999 }), dir);

    const neverAlive = (): boolean => false;
    const interrupted = sweepInterruptedTasks(process.pid, dir, neverAlive);

    expect(interrupted.map((t) => t.id)).toEqual([dead.id]);
    expect(getTask(dead.id, dir)?.status).toBe("interrupted");
    expect(getTask(ours.id, dir)?.status).toBe("running");
    expect(getTask(done.id, dir)?.status).toBe("done");

    // Second sweep: nothing left to interrupt.
    expect(sweepInterruptedTasks(process.pid, dir, neverAlive)).toEqual([]);
  });

  test("running task owned by another live process is left alone", () => {
    const dir = tempDir();
    const otherLive = createTask(baseTask({ ownerPid: 424242 }), dir);
    const alwaysAlive = (): boolean => true;
    expect(sweepInterruptedTasks(process.pid, dir, alwaysAlive)).toEqual([]);
    expect(getTask(otherLive.id, dir)?.status).toBe("running");
  });
});

describe("deliveryQueue", () => {
  test("queue / peek / drain marks delivered exactly once", () => {
    const dir = tempDir();
    queueDelivery("task_result", "task-x", "Terminée.", dir);
    queueDelivery("task_failure", "task-y", "Échouée.", dir);

    expect(peekPendingDeliveries(dir).length).toBe(2);

    const drained = drainPendingDeliveries(dir);
    expect(drained.length).toBe(2);
    expect(drained.map((d) => d.kind).sort()).toEqual([
      "task_failure",
      "task_result",
    ]);

    // Already delivered: nothing pending, records retained for audit.
    expect(drainPendingDeliveries(dir)).toEqual([]);
    expect(listDeliveries(dir).length).toBe(2);
    expect(listDeliveries(dir).every((d) => d.deliveredAt !== null)).toBe(true);
  });

  test("peek + markDeliveriesDelivered confirms only the given ids", () => {
    const dir = tempDir();
    const first = queueDelivery("task_result", "task-a", "Résultat A.", dir);
    const second = queueDelivery("task_result", "task-b", "Résultat B.", dir);

    // Peek is non-destructive: nothing is marked until the announcement
    // was actually spoken.
    expect(peekPendingDeliveries(dir).length).toBe(2);
    expect(peekPendingDeliveries(dir).length).toBe(2);

    markDeliveriesDelivered([first.id], dir);
    const pending = peekPendingDeliveries(dir);
    expect(pending.map((d) => d.id)).toEqual([second.id]);
    expect(
      listDeliveries(dir).find((d) => d.id === first.id)?.deliveredAt
    ).not.toBeNull();

    // Unknown ids and already-delivered ids are ignored.
    markDeliveriesDelivered([first.id, "dlv-unknown"], dir);
    expect(peekPendingDeliveries(dir).map((d) => d.id)).toEqual([second.id]);
  });

  test("corrupted delivery.json degrades to empty", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "delivery.json"), "][", "utf-8");
    expect(listDeliveries(dir)).toEqual([]);
    // And the queue recovers on the next write.
    queueDelivery("task_result", "task-z", "ok", dir);
    expect(peekPendingDeliveries(dir).length).toBe(1);
  });
});
