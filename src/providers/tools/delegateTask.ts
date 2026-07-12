/**
 * delegate_task tool — delegate a bounded, complex task to an installed
 * coding agent (Codex CLI or Claude Code) running in the background.
 *
 * Phase C2a/C2b/C2c (docs/phase-c2-coding-agent-delegation.md §5.1). The
 * model may only provide the fields below; executable paths, CLI flags,
 * environment variables, and sandbox options are owned by trusted
 * application code.
 */

import { IToolProvider } from "./IToolProvider";
import { getDelegationService } from "../../delegation/service";
import {
  BackendChoice,
  DelegationCapability,
  ExecutionMode,
} from "../../delegation/types";

const delegateTask: IToolProvider = {
  name: "delegate_task",
  description:
    "Delegate a bounded, complex task to a coding agent (Codex CLI or Claude Code) " +
    "that runs in the background: repository inspection, code analysis, iterative " +
    "debugging, or deep web research. Returns a task id immediately; the result is " +
    "announced to the user automatically when ready — never claim the work is " +
    "done until a delivery or delegate_status says so, and never dispatch a " +
    "duplicate of a task that is already running (check delegate_status if " +
    "unsure). State a concrete objective and acceptance criteria " +
    "in `task`. Request the least capability needed (read_only unless the user " +
    "clearly wants changes). Do NOT delegate simple calculations, current-time " +
    "requests, memory reads, or anything a direct tool already handles.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Precise, self-contained objective with acceptance criteria, e.g. " +
          "'Inspect the failing tests in this repo, explain the root cause, do not modify files.'",
      },
      capability: {
        type: "string",
        enum: ["read_only", "workspace_write", "external_action"],
        description:
          "Least capability needed. read_only runs immediately when the workspace " +
          "is allowed. workspace_write in the agent workspace (the default) runs " +
          "DIRECTLY: files are written in place, committed for rollback, and the " +
          "result lists their real absolute paths. workspace_write on any other " +
          "Git repository runs in an isolated worktree and reports a reviewable " +
          "diff/patch instead — applying it is the user's decision. " +
          "external_action (organize/convert user files, run an allowed program) " +
          "is two-stage: the agent first PREPARES an action plan without touching " +
          "anything; you must describe the plan's concrete effects to the user and " +
          "only call delegate_approve after an explicit yes.",
      },
      backend: {
        type: "string",
        enum: ["auto", "codex", "claude"],
        description:
          "Coding agent to use. Use 'auto' unless the user explicitly asked for one.",
      },
      workspace: {
        type: "string",
        description:
          "Absolute path of the workspace to operate on. Defaults to the shared " +
          "agent workspace. Must be inside the allowed delegation roots.",
      },
      web_research: {
        type: "boolean",
        description:
          "Set true for deep web-research tasks: the agent gets its built-in web " +
          "search in an empty scratch workspace (read_only only).",
      },
      execution: {
        type: "string",
        enum: ["run", "prepare"],
        description:
          "Leave as 'run' (default). external_action tasks always go through the " +
          "prepare stage first regardless; 'prepare' just states that intent " +
          "explicitly and is invalid for other capabilities.",
      },
      timeout_minutes: {
        type: "number",
        description: "Optional time budget in minutes (clamped to the configured maximum).",
      },
    },
    required: ["task", "capability"],
  },

  async execute(
    params: Record<string, unknown>,
    sandboxDir: string
  ): Promise<unknown> {
    const task = String(params.task ?? "").trim();
    if (!task) {
      return "error: delegate_task requires a non-empty task.";
    }

    const capability = String(params.capability ?? "") as DelegationCapability;
    const rawBackend = String(params.backend ?? "auto").toLowerCase();
    const backend: BackendChoice =
      rawBackend === "codex" || rawBackend === "claude" ? rawBackend : "auto";
    const webResearch = params.web_research === true;
    const timeoutMinutes =
      typeof params.timeout_minutes === "number"
        ? params.timeout_minutes
        : undefined;
    const workspace =
      typeof params.workspace === "string" && params.workspace.trim().length > 0
        ? params.workspace.trim()
        : sandboxDir;
    const execution: ExecutionMode =
      String(params.execution ?? "run") === "prepare" ? "prepare" : "run";

    try {
      const result = await getDelegationService().dispatch({
        task,
        capability,
        backend,
        workspace,
        webResearch,
        execution,
        timeoutMinutes,
      });
      return JSON.stringify(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: delegation failed to dispatch: ${msg}`;
    }
  },
};

export default delegateTask;
