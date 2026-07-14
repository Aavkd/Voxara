/**
 * pilot_cancel tool — the kill-switch (docs/phase-c3-computer-control.md
 * §4.3, §9.6). Aborts the running pilot between steps and interrupts the
 * in-flight bridge/UIA call.
 */

import { getPilotService, PilotService } from "../../control/pilot";
import { IToolProvider } from "./IToolProvider";

interface PilotCancelDependencies {
  service?: () => PilotService;
}

export function createPilotCancelTool(
  dependencies: PilotCancelDependencies = {}
): IToolProvider {
  return {
    name: "pilot_cancel",
    description:
      "Stop the running pilot: use this when the user says \"stop\" / \"arrête\" " +
      "/ \"annule\". It aborts between steps and interrupts any action in " +
      "progress. Partial effects already applied are not automatically undone.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The pilot task id to cancel (from pilot_task / pilot_status).",
        },
      },
      required: ["task_id"],
    },
    async execute(params: Record<string, unknown>): Promise<unknown> {
      const taskId = typeof params.task_id === "string" ? params.task_id.trim() : "";
      if (!taskId) {
        return "error: pilot_cancel requires a task_id.";
      }
      const service = (dependencies.service ?? getPilotService)();
      try {
        return await service.cancel(taskId);
      } catch (err: unknown) {
        return `error: pilot_cancel failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export default createPilotCancelTool();
