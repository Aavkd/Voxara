/**
 * desktop_act tool — one typed desktop intent per call: open_app, focus,
 * close, invoke, set_value, type, keys.
 *
 * Phase C3c1 (docs/phase-c3-computer-control.md §9.2, §8). The policy
 * classifies each intent by effect level; the two keyboard routes (D9) —
 * launch-with-args to RUN something, type + keys to interact with an app
 * already open — are steered by this description and gated by the policy:
 * typing literal text is reversible. Under session_grant, the one session
 * consent also covers atomic command execution (type + submit); destructive
 * actions and unbounded control_code retain their individual gate.
 */

import { loadControlCodeAuto, loadControlTrustLevel } from "../../config/loader";
import {
  argsAreExistingPaths,
  DesktopExecutor,
  getDesktopExecutor,
} from "../../control/desktop";
import { journalControl } from "../../control/journal";
import { evaluateControlIntent } from "../../control/policy";
import { fastLaneBlockedByPilot } from "../../control/pilotState";
import { DesktopAction, DesktopElement } from "../../control/types";
import { IToolProvider, ToolExecutionContext } from "./IToolProvider";

const DESKTOP_ACTIONS: readonly DesktopAction[] = [
  "open_app",
  "focus",
  "close",
  "invoke",
  "set_value",
  "type",
  "keys",
];

const REF_ACTIONS: ReadonlySet<DesktopAction> = new Set(["invoke", "set_value"]);
const TARGET_ACTIONS: ReadonlySet<DesktopAction> = new Set([
  "focus",
  "close",
  "type",
  "keys",
]);

interface DesktopActDependencies {
  executor?: () => DesktopExecutor;
  journal?: typeof journalControl;
  trustLevel?: () => ReturnType<typeof loadControlTrustLevel>;
  controlCodeAuto?: () => boolean;
}

export function createDesktopActTool(
  dependencies: DesktopActDependencies = {}
): IToolProvider {
  const journal = dependencies.journal ?? journalControl;
  const trustLevel = dependencies.trustLevel ?? loadControlTrustLevel;

  return {
    name: "desktop_act",
    description:
      "Execute ONE action on the user's Windows desktop. open_app launches an " +
      "app by friendly name (e.g. \"vs code\", \"terminal\"). When it launches a " +
      "window its result carries a window ref like \"w12345\" — REUSE that same " +
      "window for later actions (open a terminal ONCE, then keep using it); do " +
      "NOT open a new terminal for each command. focus/close/type/keys accept " +
      "target as either a window ref (\"w12345\", exact) or a title substring; " +
      "if you already opened a terminal, targeting it by name automatically " +
      "reuses the one you opened. invoke/set_value act on an element ref from the " +
      "latest desktop_read (call it first). To RUN a command in a terminal, use " +
      "ONE call: type with submit=true — it types the text and presses Enter " +
      "atomically (never a separate keys call, never repeat the type). keys sends " +
      "a bare key/chord (\"enter\", \"ctrl+s\") for GUI shortcuts. If open_app " +
      "returns a `candidates` list it is genuinely ambiguous: ask which one, then " +
      "call open_app again with app_path set to that candidate's exact path. If a " +
      "result starts with action_blocked, relay the reason and STOP: the runtime " +
      "will resume that exact call after the user's explicit yes. Do not retry it " +
      "yourself and do not change its target. Under session_grant, the single " +
      "take-control consent covers ordinary commands too: never ask for a " +
      "separate per-command confirmation after that grant.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...DESKTOP_ACTIONS],
          description: "The single desktop intent to execute.",
        },
        target: {
          type: "string",
          description:
            "open_app: the app's friendly name. focus/close/type/keys: a window ref " +
            '("w12345" from a previous result or desktop_read) or a title substring.',
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            "open_app only: launch arguments. A command to run, or file/dir paths to open.",
        },
        app_path: {
          type: "string",
          description:
            "open_app only: the exact path of the candidate to launch, chosen from a " +
            "previous open_app `candidates` list. Only use a path that list gave you.",
        },
        ref: {
          type: "string",
          description: "invoke/set_value: element ref (d1, d2, …) from the latest desktop_read.",
        },
        value: {
          type: "string",
          description: "set_value: the text to write into the element.",
        },
        text: {
          type: "string",
          description: "type: the literal text to send to the focused window (no control chars).",
        },
        submit: {
          type: "boolean",
          description:
            "type only: also press Enter after the text (types-and-runs a command " +
            "atomically). Use this to execute a command in a terminal.",
        },
        keys: {
          type: "string",
          description: 'keys: a named key or chord, e.g. "enter", "tab", "ctrl+s", "alt+f4".',
        },
      },
      required: ["action"],
    },
    async execute(
      params: Record<string, unknown>,
      _sandboxDir: string,
      context?: ToolExecutionContext
    ): Promise<unknown> {
      const action = DESKTOP_ACTIONS.find((a) => a === params.action);
      if (!action) {
        return `error: action must be one of ${DESKTOP_ACTIONS.join(", ")}`;
      }
      const lane = context?.controlLane;
      const pilotBlock = fastLaneBlockedByPilot(lane);
      if (pilotBlock) {
        return pilotBlock;
      }

      const target = typeof params.target === "string" ? params.target.trim() : undefined;
      const ref = typeof params.ref === "string" ? params.ref.trim() : undefined;
      const value = typeof params.value === "string" ? params.value : undefined;
      const text = typeof params.text === "string" ? params.text : undefined;
      const submit = params.submit === true;
      const keys = typeof params.keys === "string" ? params.keys.trim() : undefined;
      const appPath = typeof params.app_path === "string" ? params.app_path.trim() : undefined;
      const args = normalizeArgs(params.args);
      // Approval is trusted application state, never a model-generated param.
      const confirmed = context?.controlApproved === true;
      const sessionId = context?.sessionId || "unscoped";
      const executor = (dependencies.executor ?? getDesktopExecutor)();

      const invalid = validateParams(action, { target, ref, value, text, keys });
      if (invalid) {
        return `error: ${invalid}`;
      }

      // invoke/set_value classification needs the element from the last
      // outline (§9.1); an unknown/stale ref classifies as act_sensitive.
      const element: DesktopElement | undefined =
        ref && REF_ACTIONS.has(action) ? executor.lookupRef(ref) : undefined;

      const decision = evaluateControlIntent({
        intent: {
          tool: "desktop_act",
          action,
          element,
          hasArgs: action === "open_app" ? args.length > 0 : undefined,
          argsAreExistingPaths:
            action === "open_app" ? argsAreExistingPaths(args) : undefined,
          submits: action === "type" ? submit : undefined,
        },
        trustLevel: trustLevel(),
        sessionId,
        confirmed,
        controlCodeAuto: (dependencies.controlCodeAuto ?? loadControlCodeAuto)(),
      });

      const describedTarget = describeTarget(action, { target, ref, element, args, text, keys, value, submit });

      if (decision.outcome !== "allowed") {
        journal({
          sessionId,
          lane: lane ?? "fast",
          intent: `desktop_act:${action}`,
          target: describedTarget,
          policyDecision: decision.outcome,
          outcome: "blocked",
        });
        return `action_blocked (${decision.outcome}) — ${action} on ${describedTarget}. ${decision.reason}`;
      }

      try {
        const result = await executor.act({ action, target, args, appPath, ref, value, text, submit, keys });
        journal({
          sessionId,
          lane: lane ?? "fast",
          intent: `desktop_act:${action}`,
          target: describedTarget,
          policyDecision: decision.outcome,
          outcome: "success",
        });
        return result ?? "ok";
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        journal({
          sessionId,
          lane: lane ?? "fast",
          intent: `desktop_act:${action}`,
          target: describedTarget,
          policyDecision: decision.outcome,
          outcome: "error",
          error: message,
        });
        throw error;
      }
    },
  };
}

function normalizeArgs(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((a): a is string => typeof a === "string");
}

function validateParams(
  action: DesktopAction,
  params: { target?: string; ref?: string; value?: string; text?: string; keys?: string }
): string | undefined {
  if (action === "open_app" && !params.target) {
    return "open_app requires target (the application's friendly name)";
  }
  if (TARGET_ACTIONS.has(action) && !params.target) {
    return `${action} requires target (a window title substring)`;
  }
  if (REF_ACTIONS.has(action)) {
    if (!params.ref) {
      return `${action} requires ref (from the latest desktop_read what=elements)`;
    }
    if (!/^d\d+$/.test(params.ref)) {
      return (
        `"${params.ref}" is not a valid desktop ref. Refs look like "d12" and come ` +
        "ONLY from the latest desktop_read what=elements — call it first"
      );
    }
  }
  if (action === "set_value" && params.value === undefined) {
    return "set_value requires value";
  }
  if (action === "type") {
    if (params.text === undefined || params.text.length === 0) {
      return "type requires non-empty text";
    }
    // D9: literal text only. Enter/tab and other control chars must be an
    // explicit keys call — which is what the policy gates as sensitive.
    if (/[\x00-\x1f\x7f]/.test(params.text)) {
      return (
        "type only sends literal text; it cannot contain control characters " +
        '(newline, tab, …). To press Enter or another key, use action="keys" ' +
        '(e.g. keys="enter") — that is the step the policy confirms.'
      );
    }
  }
  if (action === "keys" && !params.keys) {
    return 'keys requires a key or chord, e.g. "enter" or "ctrl+s"';
  }
  return undefined;
}

function describeTarget(
  action: DesktopAction,
  parts: {
    target?: string;
    ref?: string;
    element?: DesktopElement;
    args: string[];
    text?: string;
    keys?: string;
    value?: string;
    submit?: boolean;
  }
): string {
  switch (action) {
    case "open_app":
      // Journal the full args like control_code code (§9.2): the launched
      // command is the sensitive thing.
      return parts.args.length > 0
        ? `${parts.target} [${parts.args.join(" ")}]`
        : (parts.target ?? "open_app");
    case "focus":
    case "close":
      return `window "${parts.target}"`;
    case "invoke":
    case "set_value":
      if (parts.element) {
        const suffix = action === "set_value" && parts.value !== undefined ? ` = "${parts.value}"` : "";
        return `${parts.element.controlType} "${parts.element.name}" (ref=${parts.ref})${suffix}`;
      }
      return `ref=${parts.ref} (not in the last outline)`;
    case "type":
      // type text journaled in full (§9.2); submit names it as a command run.
      return parts.submit
        ? `run \`${parts.text}\` in window "${parts.target}"`
        : `"${parts.text}" → window "${parts.target}"`;
    case "keys":
      return `${parts.keys} → window "${parts.target}"`;
    default:
      return action;
  }
}

export default createDesktopActTool();
