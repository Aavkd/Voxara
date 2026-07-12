/**
 * delegate_cancel tool — cancel a pending or running delegated task.
 *
 * Phase C2a (docs/phase-c2-coding-agent-delegation.md §5.4). Terminates the
 * supervised process tree; partial artifacts remain quarantined for
 * inspection. Cancellation never tries to undo external effects.
 */

import { IToolProvider } from "./IToolProvider";
import { getDelegationService } from "../../delegation/service";

const delegateCancel: IToolProvider = {
  name: "delegate_cancel",
  description:
    "Cancel a delegated coding-agent task: a pending task is marked cancelled, " +
    "a running task's process tree is terminated. Partial artifacts are kept " +
    "for inspection.",
  parameters: {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "The task id returned by delegate_task.",
      },
    },
    required: ["task_id"],
  },

  async execute(
    params: Record<string, unknown>,
    _sandboxDir: string
  ): Promise<unknown> {
    const taskId = String(params.task_id ?? "").trim();
    if (!taskId) {
      return "error: delegate_cancel requires a task_id.";
    }

    try {
      return await getDelegationService().cancel(taskId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: delegate_cancel failed: ${msg}`;
    }
  },
};

export default delegateCancel;
