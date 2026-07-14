import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PilotService } from "../src/control/pilot";
import { getActivePilotTaskId } from "../src/control/pilotState";
import { ILLMProvider } from "../src/providers/ILLMProvider";
import { IToolProvider } from "../src/providers/tools/IToolProvider";
import { AgentStepResult } from "../src/types";
import { getTask, listTasks } from "../src/engine/taskStore";
import { peekPendingDeliveries } from "../src/engine/deliveryQueue";

/** A provider whose promptWithTools plays a fixed script of steps. */
function scriptedProvider(steps: AgentStepResult[]): ILLMProvider {
  let i = 0;
  return {
    name: "scripted",
    validate: async () => ({ valid: true }),
    prompt: async () => {
      throw new Error("unused");
    },
    chat: async () => {
      throw new Error("unused");
    },
    streamChat: async () => {
      throw new Error("unused");
    },
    promptWithTools: async (): Promise<AgentStepResult> => {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      return step;
    },
  };
}

const toolCall = (toolName: string, params: Record<string, unknown> = {}): AgentStepResult => ({
  type: "tool_call",
  toolName,
  toolParams: params,
  inputTokens: 1,
  outputTokens: 1,
});

const finalAnswer = (text: string): AgentStepResult => ({
  type: "final_answer",
  text,
  inputTokens: 1,
  outputTokens: 1,
});

/** A fake control tool that blocks once, then succeeds on trusted approval. */
function grantGatedTool(name: string): { tool: IToolProvider; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const tool: IToolProvider = {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async (params, _dir, context) => {
      calls.push({ ...params, approved: context?.controlApproved === true });
      if (context?.controlApproved !== true) {
        return "action_blocked (needs_grant) — je prends la main ?";
      }
      return "ok";
    },
  };
  return { tool, calls };
}

function makeService(
  steps: AgentStepResult[],
  tools: IToolProvider[],
  opts: { stateBaseDir: string; idleReader?: () => Promise<number>; maxSteps?: number }
): PilotService {
  return new PilotService({
    provider: scriptedProvider(steps),
    tools,
    maxSteps: opts.maxSteps ?? 20,
    stateBaseDir: opts.stateBaseDir,
    idleReader: opts.idleReader ?? (async () => 100000),
    sandboxDir: opts.stateBaseDir,
  });
}

/** Wait until predicate holds or time runs out. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
}

describe("pilot service", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-"));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("runs an autonomous goal to a final answer and delivers the result", async () => {
    const service = makeService(
      [toolCall("browser_read"), finalAnswer("j'ai trouvé le prix")],
      [
        {
          name: "browser_read",
          description: "read",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ url: "https://a", title: "A", elements: [] }),
        },
      ],
      { stateBaseDir: stateDir }
    );

    const dispatch = service.dispatch({ goal: "trouve le prix" });
    expect(dispatch.status).toBe("running");
    const taskId = dispatch.taskId!;

    await until(() => getTask(taskId, stateDir)?.status === "done");
    const task = getTask(taskId, stateDir)!;
    expect(task.result).toContain("trouvé le prix");

    const deliveries = peekPendingDeliveries(stateDir);
    expect(deliveries.some((d) => d.kind === "task_result" && d.refId === taskId)).toBe(true);
    expect(getActivePilotTaskId()).toBeNull();
  });

  test("rejects a second pilot while one runs (concurrency 1) and blocks the fast lane", async () => {
    // A pilot that parks on an approval so it stays running.
    const { tool } = grantGatedTool("desktop_act");
    const service = makeService(
      [toolCall("desktop_act"), finalAnswer("done")],
      [tool],
      { stateBaseDir: stateDir }
    );

    const first = service.dispatch({ goal: "goal one" });
    expect(first.status).toBe("running");
    await until(() => getTask(first.taskId!, stateDir)?.status === "pending_approval");

    // Fast lane sees the active pilot.
    expect(getActivePilotTaskId()).toBe(first.taskId);

    const second = service.dispatch({ goal: "goal two" });
    expect(second.status).toBe("rejected");
    expect(second.message).toMatch(/already running/);

    await service.cancel(first.taskId!);
  });

  test("suspends on a blocked intent, queues an approval, and resumes on approve", async () => {
    const { tool, calls } = grantGatedTool("desktop_act");
    const service = makeService(
      [toolCall("desktop_act", { action: "focus" }), finalAnswer("terminé")],
      [tool],
      { stateBaseDir: stateDir }
    );

    const dispatch = service.dispatch({ goal: "fais le truc" });
    const taskId = dispatch.taskId!;

    await until(() => getTask(taskId, stateDir)?.status === "pending_approval");
    const approvals = peekPendingDeliveries(stateDir).filter((d) => d.kind === "pilot_approval");
    expect(approvals).toHaveLength(1);

    expect(service.approve(taskId)).toMatch(/resuming/);
    await until(() => getTask(taskId, stateDir)?.status === "done");

    // The blocked call was retried with a trusted application approval bit;
    // no model-visible magic flag was added to its parameters.
    expect(calls).toHaveLength(2);
    expect(calls[1].approved).toBe(true);
    expect(calls[1].confirmed).toBeUndefined();
  });

  test("pauses when the user is active, then resumes", async () => {
    let idle = 100000;
    const acted: string[] = [];
    const tool: IToolProvider = {
      name: "desktop_act",
      description: "act",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        acted.push("acted");
        return "ok";
      },
    };
    const service = makeService(
      [toolCall("desktop_act", { action: "focus" }), finalAnswer("fini")],
      [tool],
      { stateBaseDir: stateDir, idleReader: async () => idle }
    );

    idle = 200; // user just moved the mouse
    const dispatch = service.dispatch({ goal: "range les fenêtres" });
    const taskId = dispatch.taskId!;

    await until(() =>
      peekPendingDeliveries(stateDir).some((d) => d.kind === "pilot_paused")
    );
    expect(acted).toHaveLength(0); // paused BEFORE acting

    idle = 100000; // user stopped
    expect(service.resume(taskId)).toMatch(/resuming/);
    await until(() => getTask(taskId, stateDir)?.status === "done");
    expect(acted).toHaveLength(1);
  });

  test("cancel finalizes a suspended pilot as cancelled", async () => {
    const { tool } = grantGatedTool("desktop_act");
    const service = makeService(
      [toolCall("desktop_act"), finalAnswer("done")],
      [tool],
      { stateBaseDir: stateDir }
    );
    const taskId = service.dispatch({ goal: "x" }).taskId!;
    await until(() => getTask(taskId, stateDir)?.status === "pending_approval");

    await service.cancel(taskId);
    await until(() => getTask(taskId, stateDir)?.status === "cancelled");
    expect(getActivePilotTaskId()).toBeNull();
  });

  test("exhausts the step budget and fails cleanly", async () => {
    const tool: IToolProvider = {
      name: "browser_read",
      description: "read",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
    };
    // Always returns a tool call, never a final answer.
    const service = makeService([toolCall("browser_read")], [tool], {
      stateBaseDir: stateDir,
      maxSteps: 3,
    });
    const taskId = service.dispatch({ goal: "loop forever" }).taskId!;
    await until(() => getTask(taskId, stateDir)?.status === "failed");
    expect(getTask(taskId, stateDir)?.error).toMatch(/budget/);
  });

  test("startup recovery reports a pilot orphaned by a dead process", async () => {
    // Simulate a running pilot owned by a dead pid.
    const { createTask } = await import("../src/engine/taskStore");
    createTask(
      {
        id: "task-orphan-1",
        kind: "pilot",
        status: "running",
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        sessionId: null,
        ownerPid: 999999999, // not a live pid
      },
      stateDir
    );
    const service = new PilotService({
      provider: scriptedProvider([finalAnswer("x")]),
      tools: [],
      maxSteps: 5,
      stateBaseDir: stateDir,
    });
    const recovered = service.recoverInterruptedPilots();
    expect(recovered.map((t) => t.id)).toContain("task-orphan-1");
    expect(getTask("task-orphan-1", stateDir)?.status).toBe("interrupted");
    expect(
      peekPendingDeliveries(stateDir).some(
        (d) => d.refId === "task-orphan-1" && d.kind === "task_failure"
      )
    ).toBe(true);
    // Idempotent.
    expect(service.recoverInterruptedPilots()).toEqual([]);
  });
});
