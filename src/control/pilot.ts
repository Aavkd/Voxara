/**
 * Pilot service — the async lane (docs/phase-c3-computer-control.md §9.6).
 *
 * A multi-step goal is dispatched to an internal background agent running our
 * OWN loop (not a child process, unlike a C2 delegation) with exactly the
 * fast-lane control tools. It reuses the C2 task store and delivery queue:
 * immediate acknowledgment, progress in the store, and result / failure /
 * approval / pause notices through the delivery queue at the next idle voice
 * boundary. The real-time conversation is never blocked.
 *
 * Differences from runAgentLoop that force a dedicated loop here:
 *  - a `needs_confirmation` / `needs_grant` policy outcome SUSPENDS the pilot
 *    and queues a `pilot_approval` delivery; the user's yes (pilot_approve)
 *    resumes the exact call with a trusted application approval bit;
 *  - before each ACTING step the pilot checks whether the user generated
 *    input since the step began (GetLastInputInfo) and pauses (§4.3);
 *  - cancellation aborts between steps and interrupts the in-flight
 *    bridge/UIA call.
 */

import { ILLMProvider } from "../providers/ILLMProvider";
import { IToolProvider, ToolExecutionContext } from "../providers/tools/IToolProvider";
import { Message } from "../types";
import {
  appendTaskProgress,
  createTask,
  getTask,
  listTasks,
  newTaskId,
  sweepInterruptedTasks,
  TaskRecord,
  updateTask,
} from "../engine/taskStore";
import { queueDelivery } from "../engine/deliveryQueue";
import { getDesktopExecutor } from "./desktop";
import { setActivePilotTask } from "./pilotState";
import { loadConfig, loadControlPilotMaxSteps } from "../config/loader";
import { createProvider } from "../providers/factory";
import screenViewTool from "../providers/tools/screenView";
import browserReadTool from "../providers/tools/browserRead";
import browserActTool from "../providers/tools/browserAct";
import desktopReadTool from "../providers/tools/desktopRead";
import desktopActTool from "../providers/tools/desktopAct";
import controlCodeTool from "../providers/tools/controlCode";

const MAX_GOAL_CHARS = 2000;
const MAX_RESULT_CHARS = 1200;
const MAX_DELIVERY_CHARS = 300;
const MAX_TOOL_RESULT_CHARS = 6000;
/** A user-input burst within this window before an acting step ⇒ pause (§4.3). */
const RECENT_INPUT_WINDOW_MS = 1500;

/** Control tools that only observe — no pause / grant gate before them. */
const OBSERVE_TOOLS = new Set(["screen_view", "browser_read", "desktop_read"]);

export interface PilotDispatchRequest {
  goal: string;
  context?: string;
  budgetSteps?: number;
  sessionId?: string | null;
}

export interface PilotDispatchResult {
  taskId: string | null;
  status: "running" | "rejected";
  message: string;
}

/** How the pilot reads the user's idle time — injectable for tests. */
export type IdleReader = () => Promise<number>;

export interface PilotServiceOptions {
  provider: ILLMProvider;
  tools: IToolProvider[];
  maxSteps: number;
  stateBaseDir?: string;
  /** Milliseconds since the user's last input; defaults to the desktop host. */
  idleReader?: IdleReader;
  /** Sandbox dir passed to tools that need one (control tools ignore it). */
  sandboxDir?: string;
}

interface SuspendedApproval {
  resolve: (decision: "approved" | "cancelled") => void;
}

interface RunningPilot {
  taskId: string;
  cancelled: boolean;
  /** Pending approval suspension, if the pilot is waiting on the user. */
  approval?: SuspendedApproval;
  /** Pending user-input pause suspension. */
  pause?: SuspendedApproval;
  /** Interrupt the in-flight bridge/UIA call (kill-switch, §4.3). */
  interrupt(): Promise<void>;
}

export class PilotService {
  private readonly options: PilotServiceOptions;
  private readonly stateBaseDir?: string;
  private running: RunningPilot | null = null;
  private recovered = false;

  constructor(options: PilotServiceOptions) {
    this.options = options;
    this.stateBaseDir = options.stateBaseDir;
  }

  /** Is a pilot currently occupying the single lane (§9.6, concurrency 1)? */
  isBusy(): boolean {
    return this.running !== null;
  }

  activeTaskId(): string | null {
    return this.running?.taskId ?? null;
  }

  /**
   * Dispatch a pilot. Persists a `pilot` task, starts the background loop,
   * and returns immediately (§4.2). Rejects if a pilot is already running.
   */
  dispatch(request: PilotDispatchRequest): PilotDispatchResult {
    this.recoverInterruptedPilots();

    const goal = request.goal.trim();
    if (!goal) {
      return { taskId: null, status: "rejected", message: "a goal is required" };
    }
    if (this.running) {
      return {
        taskId: null,
        status: "rejected",
        message:
          `A pilot is already running (${this.running.taskId}). Only one runs at a ` +
          "time — check pilot_status, or pilot_cancel it before starting another.",
      };
    }
    // Guard against a stale record from another live process too (§9.6).
    const otherRunning = listTasks(this.stateBaseDir).some(
      (t) => t.kind === "pilot" && t.status === "running"
    );
    if (otherRunning) {
      return {
        taskId: null,
        status: "rejected",
        message: "another pilot is already marked running — cancel or wait for it first.",
      };
    }

    const budget =
      Number.isInteger(request.budgetSteps) && (request.budgetSteps ?? 0) > 0
        ? Math.min(request.budgetSteps!, this.options.maxSteps)
        : this.options.maxSteps;

    const taskId = newTaskId();
    createTask(
      {
        id: taskId,
        kind: "pilot",
        status: "running",
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        sessionId: request.sessionId ?? null,
        ownerPid: process.pid,
        task: clip(goal, MAX_GOAL_CHARS),
        contextHint: request.context?.trim().slice(0, MAX_GOAL_CHARS) ?? null,
        progress: [],
        result: null,
        error: null,
      },
      this.stateBaseDir
    );

    const pilot: RunningPilot = {
      taskId,
      cancelled: false,
      interrupt: async () => {
        // Interrupt whichever channel might be mid-call.
        try {
          await getDesktopExecutor().interrupt();
        } catch {
          // no desktop host in play — nothing to interrupt
        }
      },
    };
    this.running = pilot;
    setActivePilotTask(taskId);

    void this.runLoop(pilot, goal, budget, request.context)
      .catch((err: unknown) => {
        // A loop crash must finalize the task, never leave it "running".
        const message = err instanceof Error ? err.message : String(err);
        this.finish(pilot, "failed", `pilot loop crashed: ${message}`);
      })
      .finally(() => {
        if (this.running === pilot) {
          this.running = null;
          setActivePilotTask(null);
        }
      });

    return {
      taskId,
      status: "running",
      message:
        `Pilot ${taskId} started (budget ${budget} steps). I'll work on it in the ` +
        "background and tell you when it's done, or if I need your go-ahead.",
    };
  }

  /** Bounded status summary for the conversational model (§4.4). */
  status(taskId: string): { found: boolean; text: string } {
    const task = getTask(taskId, this.stateBaseDir);
    if (!task || task.kind !== "pilot") {
      return { found: false, text: `No pilot task with id ${taskId}.` };
    }
    const lines = [
      `Pilot ${task.id} — status: ${task.status}`,
      `Goal: ${task.task ?? "n/a"}`,
    ];
    if (task.approvalRequest) {
      lines.push(`Awaiting approval: ${task.approvalRequest}`);
    }
    const progress = (task.progress ?? []).slice(-6);
    if (progress.length > 0) {
      lines.push("Recent steps:", ...progress.map((p) => `  - ${p.text}`));
    }
    if (task.result) {
      lines.push(`Result: ${task.result}`);
    }
    if (task.error) {
      lines.push(`Failure: ${task.error}`);
    }
    return { found: true, text: lines.join("\n") };
  }

  list(limit = 10): TaskRecord[] {
    return listTasks(this.stateBaseDir)
      .filter((t) => t.kind === "pilot")
      .slice(-limit)
      .reverse();
  }

  /**
   * Approve a suspended pilot (pilot_approve, §9.6). Resumes the loop, which
   * retries the blocked tool call with trusted application approval.
   */
  approve(taskId: string): string {
    const pilot = this.running;
    if (!pilot || pilot.taskId !== taskId) {
      return `error: pilot ${taskId} is not the currently running pilot.`;
    }
    if (!pilot.approval) {
      return `error: pilot ${taskId} is not waiting for an approval right now.`;
    }
    const approval = pilot.approval;
    pilot.approval = undefined;
    updateTask(taskId, { status: "running", approvalRequest: null }, this.stateBaseDir);
    approval.resolve("approved");
    return `Approval granted — pilot ${taskId} is resuming.`;
  }

  /** Resume a pilot paused by user input (§4.3). */
  resume(taskId: string): string {
    const pilot = this.running;
    if (!pilot || pilot.taskId !== taskId) {
      return `error: pilot ${taskId} is not the currently running pilot.`;
    }
    if (!pilot.pause) {
      return `error: pilot ${taskId} is not paused.`;
    }
    const pause = pilot.pause;
    pilot.pause = undefined;
    updateTask(taskId, { status: "running" }, this.stateBaseDir);
    pause.resolve("approved");
    return `Pilot ${taskId} is resuming.`;
  }

  /**
   * Cancel the running pilot (pilot_cancel, §4.3): abort between steps and
   * interrupt any in-flight call. Resolves a pending suspension so the loop
   * unwinds to its cancelled finalizer.
   */
  async cancel(taskId: string): Promise<string> {
    const pilot = this.running;
    if (!pilot || pilot.taskId !== taskId) {
      const task = getTask(taskId, this.stateBaseDir);
      if (task && task.kind === "pilot" && task.status === "running") {
        // Orphan from a dead process — finalize the record directly.
        updateTask(
          taskId,
          { status: "cancelled", completedAt: new Date().toISOString(), error: "cancelled by user" },
          this.stateBaseDir
        );
        return `Pilot ${taskId} marked cancelled.`;
      }
      return `error: pilot ${taskId} is not running.`;
    }
    pilot.cancelled = true;
    pilot.approval?.resolve("cancelled");
    pilot.approval = undefined;
    pilot.pause?.resolve("cancelled");
    pilot.pause = undefined;
    await pilot.interrupt();
    return `Pilot ${taskId} is being cancelled.`;
  }

  /**
   * Startup recovery (§8.2 non-goal note): an in-flight pilot cannot survive
   * the process dying — report interrupted pilots once on startup. Idempotent.
   */
  recoverInterruptedPilots(): TaskRecord[] {
    if (this.recovered) {
      return [];
    }
    this.recovered = true;
    const interrupted = sweepInterruptedTasks(
      process.pid,
      this.stateBaseDir,
      undefined,
      ["pilot"]
    );
    for (const task of interrupted) {
      queueDelivery(
        "task_failure",
        task.id,
        `Le pilote ${task.id} a été interrompu par un arrêt de Voxara et n'a pas abouti. ` +
          "Tu peux relancer l'objectif si besoin.",
        this.stateBaseDir
      );
    }
    return interrupted;
  }

  // ── The loop ──────────────────────────────────────────────────────

  private async runLoop(
    pilot: RunningPilot,
    goal: string,
    budget: number,
    context?: string
  ): Promise<void> {
    const provider = this.options.provider;
    if (!provider.promptWithTools) {
      this.finish(pilot, "failed", `provider "${provider.name}" does not support tool use`);
      return;
    }

    const tools = this.options.tools;
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const sandboxDir = this.options.sandboxDir ?? process.cwd();
    const toolContext: ToolExecutionContext = {
      sessionId: this.taskSessionId(pilot.taskId),
      controlLane: "pilot",
      activeProvider: provider,
    };

    const messages: Message[] = [
      {
        role: "user",
        content: buildPilotPrompt(goal, context),
        timestamp: Date.now(),
      },
    ];

    for (let step = 0; step < budget; step++) {
      if (pilot.cancelled) {
        this.finish(pilot, "cancelled", "cancelled by user");
        return;
      }

      const stepResult = await provider.promptWithTools(messages, tools);

      if (stepResult.type === "final_answer") {
        this.finish(pilot, "done", clip(stepResult.text ?? "", MAX_RESULT_CHARS) || "done");
        return;
      }

      const calls = [
        {
          toolName: stepResult.toolName!,
          toolParams: stepResult.toolParams ?? {},
          thoughtSignature: stepResult.thoughtSignature,
        },
        ...(stepResult.extraToolCalls ?? []),
      ];

      for (const { toolName, toolParams, thoughtSignature } of calls) {
        if (pilot.cancelled) {
          this.finish(pilot, "cancelled", "cancelled by user");
          return;
        }

        // User-input pause before an ACTING step (§4.3).
        if (!OBSERVE_TOOLS.has(toolName)) {
          const paused = await this.maybePause(pilot);
          if (paused === "cancelled") {
            this.finish(pilot, "cancelled", "cancelled by user");
            return;
          }
        }

        let params = { ...toolParams };
        let toolResult = await this.executeTool(toolMap, toolName, params, sandboxDir, toolContext);

        // A blocked control intent suspends the pilot for approval (§9.6).
        if (isActionBlocked(toolResult)) {
          appendTaskProgress(pilot.taskId, `awaiting approval: ${toolName}`, this.stateBaseDir);
          const decision = await this.suspendForApproval(pilot, toolName, toolResult);
          if (decision === "cancelled") {
            this.finish(pilot, "cancelled", "cancelled by user");
            return;
          }
          toolResult = await this.executeTool(toolMap, toolName, params, sandboxDir, {
            ...toolContext,
            controlApproved: true,
          });
        }

        appendTaskProgress(
          pilot.taskId,
          `${toolName} → ${summarizeResult(toolResult)}`,
          this.stateBaseDir
        );
        appendToolExchange(messages, toolName, params, toolResult, thoughtSignature);
      }
    }

    this.finish(pilot, "failed", `step budget exhausted (${budget} steps)`);
  }

  private async executeTool(
    toolMap: Map<string, IToolProvider>,
    toolName: string,
    params: Record<string, unknown>,
    sandboxDir: string,
    context: ToolExecutionContext
  ): Promise<unknown> {
    const tool = toolMap.get(toolName);
    if (!tool) {
      return `error: unknown tool "${toolName}"`;
    }
    try {
      return await tool.execute(params, sandboxDir, context);
    } catch (err: unknown) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Suspend the loop until pilot_approve or pilot_cancel (§9.6). */
  private suspendForApproval(
    pilot: RunningPilot,
    toolName: string,
    blockedResult: unknown
  ): Promise<"approved" | "cancelled"> {
    const reason = typeof blockedResult === "string" ? blockedResult : String(blockedResult);
    updateTask(
      pilot.taskId,
      { status: "pending_approval", approvalRequest: reason },
      this.stateBaseDir
    );
    queueDelivery(
      "pilot_approval",
      pilot.taskId,
      `Le pilote ${pilot.taskId} a besoin de ton accord pour continuer : ` +
        `${clip(reason, MAX_DELIVERY_CHARS)} — dis oui pour que je poursuive, ou demande-moi d'arrêter.`,
      this.stateBaseDir
    );
    return new Promise<"approved" | "cancelled">((resolve) => {
      pilot.approval = { resolve };
    });
  }

  /**
   * Pause the pilot if the user generated input in the last moment (§4.3).
   * Best-effort: if the idle reader is unavailable, the pilot proceeds.
   */
  private async maybePause(pilot: RunningPilot): Promise<"approved" | "cancelled" | "proceed"> {
    let idleMs: number;
    try {
      idleMs = await (this.options.idleReader ?? defaultIdleReader)();
    } catch {
      return "proceed"; // no idle signal (e.g. no desktop host) — do not block
    }
    if (idleMs >= RECENT_INPUT_WINDOW_MS) {
      return "proceed";
    }
    updateTask(pilot.taskId, { status: "running" }, this.stateBaseDir);
    queueDelivery(
      "pilot_paused",
      pilot.taskId,
      `Je te laisse la main — tu es en train d'utiliser l'ordinateur. ` +
        `Dis-moi « reprends » quand je peux continuer le pilote ${pilot.taskId}, ou « annule ».`,
      this.stateBaseDir
    );
    return new Promise<"approved" | "cancelled" | "proceed">((resolve) => {
      pilot.pause = { resolve: (d) => resolve(d) };
    });
  }

  private finish(
    pilot: RunningPilot,
    status: "done" | "failed" | "cancelled",
    detail: string
  ): void {
    const current = getTask(pilot.taskId, this.stateBaseDir);
    if (current && (current.status === "cancelled" || current.status === "done" || current.status === "failed")) {
      // already finalized (e.g. by an orphan cancel) — don't double-deliver
      if (this.running === pilot) {
        this.running = null;
        setActivePilotTask(null);
      }
      return;
    }
    updateTask(
      pilot.taskId,
      {
        status,
        completedAt: new Date().toISOString(),
        result: status === "done" ? clip(detail, MAX_RESULT_CHARS) : null,
        error: status === "done" ? null : clip(detail, MAX_RESULT_CHARS),
        approvalRequest: null,
      },
      this.stateBaseDir
    );
    if (status === "done") {
      queueDelivery(
        "task_result",
        pilot.taskId,
        `Le pilote ${pilot.taskId} a terminé : ${clip(detail, MAX_DELIVERY_CHARS)}`,
        this.stateBaseDir
      );
    } else if (status === "failed") {
      queueDelivery(
        "task_failure",
        pilot.taskId,
        `Le pilote ${pilot.taskId} s'est arrêté : ${clip(detail, MAX_DELIVERY_CHARS)}`,
        this.stateBaseDir
      );
    } else {
      queueDelivery(
        "task_failure",
        pilot.taskId,
        `Le pilote ${pilot.taskId} a été annulé.`,
        this.stateBaseDir
      );
    }
    if (this.running === pilot) {
      this.running = null;
      setActivePilotTask(null);
    }
  }

  private taskSessionId(taskId: string): string {
    return getTask(taskId, this.stateBaseDir)?.sessionId ?? taskId;
  }
}

function defaultIdleReader(): Promise<number> {
  return getDesktopExecutor().idleMs();
}

/** A control tool returns `action_blocked (needs_…)` when the policy gates it. */
function isActionBlocked(result: unknown): boolean {
  return typeof result === "string" && result.startsWith("action_blocked (needs_");
}

function summarizeResult(result: unknown): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return clip(text.replace(/\s+/g, " "), 160);
}

function appendToolExchange(
  messages: Message[],
  toolName: string,
  params: Record<string, unknown>,
  result: unknown,
  thoughtSignature?: string
): void {
  const image = asImageResult(result);
  messages.push({
    role: "model",
    content: [{ type: "tool_call", name: toolName, args: params, thoughtSignature }],
    timestamp: Date.now(),
  });
  messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        name: toolName,
        result: image
          ? image.note ?? "image captured — attached in the next message"
          : clip(typeof result === "string" ? result : JSON.stringify(result), MAX_TOOL_RESULT_CHARS),
      },
    ],
    timestamp: Date.now(),
  });
  if (image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `Capture returned by ${toolName}:` },
        { type: "image", mimeType: image.mimeType, base64: image.base64 },
      ],
      timestamp: Date.now(),
    });
  }
}

interface ImageResult {
  kind: "image";
  mimeType: "image/png" | "image/jpeg";
  base64: string;
  note?: string;
}

function asImageResult(value: unknown): ImageResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ImageResult>;
  if (
    candidate.kind !== "image" ||
    (candidate.mimeType !== "image/png" && candidate.mimeType !== "image/jpeg") ||
    typeof candidate.base64 !== "string"
  ) {
    return null;
  }
  return candidate as ImageResult;
}

function buildPilotPrompt(goal: string, context?: string): string {
  return [
    "You are Voxara's background pilot: you pursue a multi-step goal on the",
    "user's computer using ONLY the control tools available to you. Work",
    "autonomously and end with a short final answer summarizing what you did",
    "and what you found. Guidance:",
    "- Observe before acting: browser_read / desktop_read to get fresh refs,",
    "  screen_view when you need to see the screen.",
    "- One intent per tool call; use refs only from your latest read.",
    "- If a tool result starts with `action_blocked`, the user is being asked",
    "  to approve it — do NOT try to work around it; just call the tool again",
    "  unchanged and it will proceed once approved.",
    "- Stop as soon as the goal is achieved; do not keep acting for its own sake.",
    "",
    context ? `Context: ${context}` : "",
    `Goal: ${goal}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function clip(text: string, max: number): string {
  const clean = (text ?? "").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// ── Application-level singleton ──────────────────────────────────────

let pilotServiceInstance: PilotService | null = null;

/**
 * The pilot's fast-lane control tool set (§9.6): the same tools the
 * conversational agent has, minus the pilot_* tools themselves.
 */
export function pilotControlTools(): IToolProvider[] {
  return [
    screenViewTool,
    browserReadTool,
    browserActTool,
    desktopReadTool,
    desktopActTool,
    controlCodeTool,
  ];
}

export function getPilotService(): PilotService {
  if (!pilotServiceInstance) {
    pilotServiceInstance = new PilotService({
      provider: createProvider(loadConfig()),
      tools: pilotControlTools(),
      maxSteps: loadControlPilotMaxSteps(),
    });
    pilotServiceInstance.recoverInterruptedPilots();
  }
  return pilotServiceInstance;
}

/** Test hook: drop the singleton so the next access rebuilds it. */
export function resetPilotServiceForTests(): void {
  pilotServiceInstance = null;
}
