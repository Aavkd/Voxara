/**
 * desktop_read tool — observe the desktop: the open top-level windows, or a
 * UI Automation outline of one window.
 *
 * Phase C3c1 (docs/phase-c3-computer-control.md §9.1). Effect level:
 * observe — always allowed under every trust level, always journaled.
 */

import { loadControlTrustLevel } from "../../config/loader";
import { DesktopExecutor, getDesktopExecutor } from "../../control/desktop";
import { journalControl } from "../../control/journal";
import { evaluateControlIntent } from "../../control/policy";
import { IToolProvider, ToolExecutionContext } from "./IToolProvider";

interface DesktopReadDependencies {
  executor?: () => DesktopExecutor;
  journal?: typeof journalControl;
}

export function createDesktopReadTool(
  dependencies: DesktopReadDependencies = {}
): IToolProvider {
  const journal = dependencies.journal ?? journalControl;

  return {
    name: "desktop_read",
    description:
      "Observe the user's Windows desktop: what=windows lists the open " +
      "top-level windows (title, process, pid, focused); what=elements " +
      "returns a UI Automation outline of ONE window matched by a title " +
      "substring — interactive elements with ephemeral refs (d1, d2, …). " +
      "Always call this before desktop_act invoke/set_value and use fresh " +
      "refs: refs die on the next elements read and when the window closes. " +
      "If the result lists `ambiguous` titles, ask the user (or refine the " +
      "target) instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        what: {
          type: "string",
          enum: ["windows", "elements"],
          description: "windows = open window list; elements = UIA outline of one window.",
        },
        target: {
          type: "string",
          description:
            "Window title substring (case- and accent-insensitive). Required when what=elements.",
        },
      },
      required: ["what"],
    },
    async execute(
      params: Record<string, unknown>,
      _sandboxDir: string,
      context?: ToolExecutionContext
    ): Promise<unknown> {
      const what =
        params.what === "windows" ? "windows" : params.what === "elements" ? "elements" : undefined;
      if (!what) {
        return 'error: what must be "windows" or "elements"';
      }
      const target = typeof params.target === "string" ? params.target.trim() : "";
      if (what === "elements" && !target) {
        return "error: what=elements requires target (a window title substring)";
      }
      const sessionId = context?.sessionId || "unscoped";
      const executor = (dependencies.executor ?? getDesktopExecutor)();

      // Observation is free under every trust level (§8.2) — evaluated anyway
      // so the journal records the decision uniformly.
      const decision = evaluateControlIntent({
        intent: { tool: "desktop_read" },
        trustLevel: loadControlTrustLevel(),
        sessionId,
        confirmed: false,
      });

      const journalTarget = what === "elements" ? `window:${target}` : "windows";
      try {
        const result =
          what === "windows"
            ? await executor.listWindows()
            : await executor.readElements(target);
        journal({
          sessionId,
          lane: context?.controlLane ?? "fast",
          intent: `desktop_read:${what}`,
          target: journalTarget,
          policyDecision: decision.outcome,
          outcome: "success",
        });
        return result;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        journal({
          sessionId,
          lane: context?.controlLane ?? "fast",
          intent: `desktop_read:${what}`,
          target: journalTarget,
          policyDecision: decision.outcome,
          outcome: "error",
          error: message,
        });
        throw error;
      }
    },
  };
}

export default createDesktopReadTool();
