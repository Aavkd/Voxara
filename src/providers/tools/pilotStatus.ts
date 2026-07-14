/**
 * pilot_status tool — bounded status of a background pilot, or the recent
 * pilot list (docs/phase-c3-computer-control.md §4.4, §9.6).
 */

import { getPilotService, PilotService } from "../../control/pilot";
import { IToolProvider } from "./IToolProvider";

interface PilotStatusDependencies {
  service?: () => PilotService;
}

export function createPilotStatusTool(
  dependencies: PilotStatusDependencies = {}
): IToolProvider {
  return {
    name: "pilot_status",
    description:
      "Check the background pilot: pass a task_id for that pilot's status and " +
      "recent steps, or omit it to list recent pilots. Use this to answer " +
      "\"où en est le pilote ?\" without interrupting its work.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The pilot task id (from pilot_task). Omit to list recent pilots.",
        },
      },
    },
    async execute(params: Record<string, unknown>): Promise<unknown> {
      const service = (dependencies.service ?? getPilotService)();
      const taskId = typeof params.task_id === "string" ? params.task_id.trim() : "";
      if (taskId) {
        return service.status(taskId).text;
      }
      const recent = service.list();
      if (recent.length === 0) {
        return "No pilots have run yet.";
      }
      return recent
        .map((t) => `${t.id} — ${t.status} — ${t.task ?? ""}`.trim())
        .join("\n");
    },
  };
}

export default createPilotStatusTool();
