/**
 * pilot_approve tool — the user's go-ahead to a suspended pilot
 * (docs/phase-c3-computer-control.md §9.6). Resolves whichever suspension is
 * pending: an approval the pilot is waiting on, or a user-input pause
 * ("reprends"). Mirrors delegate_approve's conversational contract.
 */

import { getPilotService, PilotService } from "../../control/pilot";
import { IToolProvider } from "./IToolProvider";

interface PilotApproveDependencies {
  service?: () => PilotService;
}

export function createPilotApproveTool(
  dependencies: PilotApproveDependencies = {}
): IToolProvider {
  return {
    name: "pilot_approve",
    description:
      "Give a suspended pilot the user's go-ahead: use this after the user " +
      "explicitly says yes to an approval the pilot requested, or says to " +
      "resume (\"reprends\") after it paused because they were using the " +
      "computer. Only call it after an explicit yes.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The pilot task id awaiting approval or paused.",
        },
      },
      required: ["task_id"],
    },
    async execute(params: Record<string, unknown>): Promise<unknown> {
      const taskId = typeof params.task_id === "string" ? params.task_id.trim() : "";
      if (!taskId) {
        return "error: pilot_approve requires a task_id.";
      }
      const service = (dependencies.service ?? getPilotService)();
      // A pilot is either awaiting an approval or paused — try approval first,
      // fall back to resuming a pause so one tool covers both "oui" and
      // "reprends".
      const approved = service.approve(taskId);
      if (!approved.startsWith("error:")) {
        return approved;
      }
      const resumed = service.resume(taskId);
      if (!resumed.startsWith("error:")) {
        return resumed;
      }
      return approved; // neither pending — relay the clearer approval error
    },
  };
}

export default createPilotApproveTool();
