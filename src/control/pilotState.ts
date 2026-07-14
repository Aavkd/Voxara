/**
 * Pilot lane state shared between the pilot service and the fast-lane tools
 * (docs/phase-c3-computer-control.md §9.6): a pilot and the fast lane never
 * run concurrently — while a pilot is running, fast-lane ACTING tools return
 * "pilot en cours" with the task id. Kept in its own module so the tools do
 * not import the pilot service (which imports the tools).
 */

let activePilotTaskId: string | null = null;

export function setActivePilotTask(taskId: string | null): void {
  activePilotTaskId = taskId;
}

export function getActivePilotTaskId(): string | null {
  return activePilotTaskId;
}

/**
 * Fast-lane guard used by the acting tools (browser_act, desktop_act,
 * control_code). Returns the user-relayable refusal, or null when the call
 * may proceed. The pilot's own tool calls pass lane="pilot".
 */
export function fastLaneBlockedByPilot(lane?: "fast" | "pilot"): string | null {
  if (lane === "pilot" || activePilotTaskId === null) {
    return null;
  }
  return (
    `action_blocked (pilot_running) — le pilote ${activePilotTaskId} est en cours : ` +
    "les actions directes sont suspendues pendant qu'il travaille. " +
    "Utilise pilot_status pour suivre, ou pilot_cancel pour l'arrêter."
  );
}
