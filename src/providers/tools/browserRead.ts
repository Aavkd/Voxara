/**
 * browser_read tool — observe the user's real Chrome: a compact
 * accessibility-style snapshot of a page, or the tab list.
 *
 * Phase C3b (docs/phase-c3-computer-control.md §7.3). Effect level: observe —
 * always allowed under every trust level, always journaled.
 */

import { loadControlTrustLevel } from "../../config/loader";
import { BrowserExecutor, getBrowserExecutor } from "../../control/executor";
import { journalControl } from "../../control/journal";
import { evaluateControlIntent } from "../../control/policy";
import { IToolProvider, ToolExecutionContext } from "./IToolProvider";

interface BrowserReadDependencies {
  executor?: () => BrowserExecutor;
  journal?: typeof journalControl;
}

export function createBrowserReadTool(
  dependencies: BrowserReadDependencies = {}
): IToolProvider {
  const journal = dependencies.journal ?? journalControl;

  return {
    name: "browser_read",
    description:
      "Read the user's REAL Chrome browser through the paired Voxara extension: " +
      "what=page returns a compact outline of the active tab (url, title, and " +
      "interactive elements with ephemeral refs), what=tabs lists the open tabs. " +
      "Always call this before browser_act on an element and use fresh refs — " +
      "refs are invalidated by navigation and by the next snapshot.",
    parameters: {
      type: "object",
      properties: {
        what: {
          type: "string",
          enum: ["page", "tabs"],
          description: "page = snapshot of the active (or given) tab; tabs = open tab list.",
        },
        tab_id: {
          type: "number",
          description: "Optional tab id from a previous tab list; defaults to the active tab.",
        },
      },
      required: ["what"],
    },
    async execute(
      params: Record<string, unknown>,
      _sandboxDir: string,
      context?: ToolExecutionContext
    ): Promise<unknown> {
      const what = params.what === "tabs" ? "tabs" : params.what === "page" ? "page" : undefined;
      if (!what) {
        return 'error: what must be "page" or "tabs"';
      }
      const tabId = typeof params.tab_id === "number" ? params.tab_id : undefined;
      const sessionId = context?.sessionId || "unscoped";
      const executor = (dependencies.executor ?? getBrowserExecutor)();

      // Observation is free under every trust level (§8.2) — evaluated anyway
      // so the journal records the decision uniformly.
      const decision = evaluateControlIntent({
        intent: { tool: "browser_read" },
        trustLevel: loadControlTrustLevel(),
        sessionId,
        confirmed: false,
      });

      try {
        const result = what === "page"
          ? await executor.readPage(tabId)
          : await executor.listTabs();
        journal({
          sessionId,
          lane: "fast",
          intent: `browser_read:${what}`,
          target: tabId !== undefined ? `tab:${tabId}` : "active_tab",
          policyDecision: decision.outcome,
          outcome: "success",
        });
        return result;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        journal({
          sessionId,
          lane: "fast",
          intent: `browser_read:${what}`,
          target: tabId !== undefined ? `tab:${tabId}` : "active_tab",
          policyDecision: decision.outcome,
          outcome: "error",
          error: message,
        });
        throw error;
      }
    },
  };
}

export default createBrowserReadTool();
