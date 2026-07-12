/**
 * delegate_approve tool — grant the approval a prepared delegated task is
 * waiting for and start its apply stage.
 *
 * Phase C2c (docs/phase-c2-coding-agent-delegation.md §5.3). The grant is
 * scoped to one task and must name that task's own capability — approval can
 * never expand roots or change the task's intent; the service re-validates
 * the manifest so exactly the reviewed plan is applied.
 */

import { IToolProvider } from "./IToolProvider";
import { getDelegationService } from "../../delegation/service";

const delegateApprove: IToolProvider = {
  name: "delegate_approve",
  description:
    "Approve a delegated task that is pending_approval and start applying its " +
    "prepared action plan. Call this ONLY after describing the plan's concrete " +
    "effects to the user and receiving an explicit affirmative answer — never " +
    "on your own initiative. The approval is scoped to this one task; if the " +
    "user declines, call delegate_cancel instead (the prepared plan stays " +
    "available for inspection without being applied).",
  parameters: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The pending_approval task id returned by delegate_task.",
      },
      capability: {
        type: "string",
        enum: ["read_only", "workspace_write", "external_action"],
        description:
          "The exact capability being granted — must match the capability the " +
          "task originally requested (approval cannot expand scope).",
      },
    },
    required: ["task_id", "capability"],
  },

  async execute(
    params: Record<string, unknown>,
    _sandboxDir: string
  ): Promise<unknown> {
    const taskId = String(params.task_id ?? "").trim();
    if (!taskId) {
      return "error: delegate_approve requires a task_id.";
    }
    const capability = String(params.capability ?? "").trim();
    if (!capability) {
      return "error: delegate_approve requires the exact capability being granted.";
    }

    try {
      return await getDelegationService().approve(taskId, capability);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: delegate_approve failed: ${msg}`;
    }
  },
};

export default delegateApprove;
