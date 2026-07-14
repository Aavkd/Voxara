/**
 * pilot_task tool — dispatch a multi-step goal to the background pilot
 * (docs/phase-c3-computer-control.md §4.2, §9.6).
 *
 * The pilot runs an internal agent loop with the control tools, off the
 * conversational and voice hot paths. This returns immediately with a task
 * id; progress, the result, any needed approval, and pauses are announced
 * through the delivery queue.
 */

import { getPilotService, PilotService } from "../../control/pilot";
import { IToolProvider, ToolExecutionContext } from "./IToolProvider";

interface PilotTaskDependencies {
  service?: () => PilotService;
}

export function createPilotTaskTool(
  dependencies: PilotTaskDependencies = {}
): IToolProvider {
  return {
    name: "pilot_task",
    description:
      "Dispatch a multi-step computer goal to the background pilot when it " +
      "clearly needs several observe→act steps (e.g. \"compare ce produit sur " +
      "trois sites\", \"ferme toutes les fenêtres sauf Chrome\"). It runs " +
      "autonomously with the control tools and never blocks the conversation. " +
      "Acknowledge to the user that you'll handle it in the background and tell " +
      "them when it's done — do NOT wait. For a single action, use the fast-lane " +
      "tools (browser_act / desktop_act) instead. Only one pilot runs at a time.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "The multi-step goal, in the user's words.",
        },
        context: {
          type: "string",
          description: "Optional relevant context (what's on screen, constraints).",
        },
        budget_steps: {
          type: "number",
          description: "Optional cap on the number of steps (defaults to the configured budget).",
        },
      },
      required: ["goal"],
    },
    async execute(
      params: Record<string, unknown>,
      _sandboxDir: string,
      context?: ToolExecutionContext
    ): Promise<unknown> {
      const goal = typeof params.goal === "string" ? params.goal.trim() : "";
      if (!goal) {
        return "error: pilot_task requires a goal.";
      }
      const ctx = typeof params.context === "string" ? params.context : undefined;
      const budgetSteps =
        typeof params.budget_steps === "number" ? params.budget_steps : undefined;

      const service = (dependencies.service ?? getPilotService)();
      const result = service.dispatch({
        goal,
        context: ctx,
        budgetSteps,
        sessionId: context?.sessionId ?? null,
      });
      if (result.status === "rejected") {
        return `pilot_not_started — ${result.message}`;
      }
      return `pilot_started task_id=${result.taskId}. ${result.message}`;
    },
  };
}

export default createPilotTaskTool();
