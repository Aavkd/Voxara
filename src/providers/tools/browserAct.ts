/**
 * browser_act tool — one typed browser intent per call, executed in the
 * user's real Chrome through the paired extension.
 *
 * Phase C3b (docs/phase-c3-computer-control.md §7.3, §8). The policy
 * classifies each intent by effect level; needs_grant / needs_confirmation
 * outcomes are returned to the conversational agent. The runtime remembers
 * and resumes the exact call after an explicit yes (same conversational
 * contract as C2 approvals, without a model-generated confirmation flag).
 */

import { loadControlTrustLevel } from "../../config/loader";
import { BrowserExecutor, getBrowserExecutor } from "../../control/executor";
import { journalControl } from "../../control/journal";
import { evaluateControlIntent } from "../../control/policy";
import { BrowserAction, SnapshotElement } from "../../control/types";
import { IToolProvider, ToolExecutionContext } from "./IToolProvider";

const BROWSER_ACTIONS: readonly BrowserAction[] = [
  "click",
  "fill",
  "select",
  "navigate",
  "open_tab",
  "activate_tab",
  "close_tab",
  "scroll_to",
];

const REF_ACTIONS: ReadonlySet<BrowserAction> = new Set([
  "click",
  "fill",
  "select",
  "scroll_to",
]);

interface BrowserActDependencies {
  executor?: () => BrowserExecutor;
  journal?: typeof journalControl;
  trustLevel?: () => ReturnType<typeof loadControlTrustLevel>;
}

export function createBrowserActTool(
  dependencies: BrowserActDependencies = {}
): IToolProvider {
  const journal = dependencies.journal ?? journalControl;
  const trustLevel = dependencies.trustLevel ?? loadControlTrustLevel;

  return {
    name: "browser_act",
    description:
      "Execute ONE action in the user's real Chrome browser via the paired " +
      "extension: click / fill / select / scroll_to an element by ref, " +
      "navigate the active tab, or open_tab / activate_tab / close_tab. " +
      "Call browser_read first and use a FRESH ref — refs die on navigation " +
      "and on each new snapshot. If the result starts with action_blocked, " +
      "relay the reason and STOP: the runtime resumes that exact call after " +
      "the user's explicit yes. Never retry or change it yourself.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...BROWSER_ACTIONS],
          description: "The single browser intent to execute.",
        },
        ref: {
          type: "string",
          description: "Element ref from the latest browser_read snapshot (click/fill/select/scroll_to).",
        },
        value: {
          type: "string",
          description: "Text to fill, or option to select.",
        },
        url: {
          type: "string",
          description: "Destination for navigate/open_tab (http/https only).",
        },
        tab_id: {
          type: "number",
          description: "Tab id for activate_tab/close_tab (close defaults to the active tab).",
        },
      },
      required: ["action"],
    },
    async execute(
      params: Record<string, unknown>,
      _sandboxDir: string,
      context?: ToolExecutionContext
    ): Promise<unknown> {
      const action = parseAction(params.action);
      if (!action) {
        return `error: action must be one of ${BROWSER_ACTIONS.join(", ")}`;
      }
      const ref = typeof params.ref === "string" ? params.ref.trim() : undefined;
      const value = typeof params.value === "string" ? params.value : undefined;
      const url = typeof params.url === "string" ? params.url.trim() : undefined;
      const tabId = typeof params.tab_id === "number" ? params.tab_id : undefined;
      // Approval is trusted application state, never a model-generated param.
      const confirmed = context?.controlApproved === true;
      const sessionId = context?.sessionId || "unscoped";
      const executor = (dependencies.executor ?? getBrowserExecutor)();

      const invalid = validateParams(action, { ref, value, url, tabId });
      if (invalid) {
        return `error: ${invalid}`;
      }

      // Classification needs the element's state bits from the last snapshot
      // (§8.1); an unknown ref classifies as act_sensitive rather than failing.
      const element: SnapshotElement | undefined =
        ref && REF_ACTIONS.has(action) ? executor.lookupRef(ref) : undefined;

      const decision = evaluateControlIntent({
        intent: { tool: "browser_act", action, element },
        trustLevel: trustLevel(),
        sessionId,
        confirmed,
      });

      const target = describeTarget(action, { ref, element, url, tabId, value });

      if (decision.outcome !== "allowed") {
        journal({
          sessionId,
          lane: "fast",
          intent: `browser_act:${action}`,
          target,
          policyDecision: decision.outcome,
          outcome: "blocked",
        });
        return `action_blocked (${decision.outcome}) — ${action} on ${target}. ${decision.reason}`;
      }

      try {
        const result = await executor.act({ action, ref, value, url, tabId });
        journal({
          sessionId,
          lane: "fast",
          intent: `browser_act:${action}`,
          target,
          policyDecision: decision.outcome,
          outcome: "success",
        });
        return result ?? "ok";
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        journal({
          sessionId,
          lane: "fast",
          intent: `browser_act:${action}`,
          target,
          policyDecision: decision.outcome,
          outcome: "error",
          error: message,
        });
        throw error;
      }
    },
  };
}

function parseAction(raw: unknown): BrowserAction | undefined {
  return BROWSER_ACTIONS.find((action) => action === raw);
}

function validateParams(
  action: BrowserAction,
  params: { ref?: string; value?: string; url?: string; tabId?: number }
): string | undefined {
  if (REF_ACTIONS.has(action) && !params.ref) {
    return `${action} requires ref (from the latest browser_read snapshot)`;
  }
  // Invented refs (XPaths, CSS selectors, bare numbers) are a known model
  // failure mode — reject them before the policy or the bridge sees them.
  if (params.ref && !/^e\d+$/.test(params.ref)) {
    return (
      `"${params.ref}" is not a valid ref. Refs look like "e12" and come ONLY ` +
      "from the latest browser_read snapshot — call browser_read first and use " +
      "one of its refs; never invent selectors or XPaths"
    );
  }
  if ((action === "fill" || action === "select") && params.value === undefined) {
    return `${action} requires value`;
  }
  if (action === "navigate" || action === "open_tab") {
    if (!params.url) {
      return `${action} requires url`;
    }
    if (!/^https?:\/\//i.test(params.url)) {
      return `${action} only accepts http(s) URLs`;
    }
  }
  if (action === "activate_tab" && params.tabId === undefined) {
    return "activate_tab requires tab_id (from browser_read what=tabs)";
  }
  return undefined;
}

function describeTarget(
  action: BrowserAction,
  parts: {
    ref?: string;
    element?: SnapshotElement;
    url?: string;
    tabId?: number;
    value?: string;
  }
): string {
  if (parts.element) {
    return `${parts.element.role} "${parts.element.name}" (ref=${parts.ref})`;
  }
  if (parts.ref) {
    return `ref=${parts.ref} (not in the last snapshot)`;
  }
  if (parts.url) {
    return parts.url;
  }
  if (parts.tabId !== undefined) {
    return `tab:${parts.tabId}`;
  }
  return action === "close_tab" ? "active_tab" : action;
}

export default createBrowserActTool();
