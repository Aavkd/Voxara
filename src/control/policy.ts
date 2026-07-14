/**
 * Control policy — effect-level classification and trust-level decisions.
 *
 * Phase C3b (docs/phase-c3-computer-control.md §8). Same spirit as
 * src/delegation/policy.ts: general typed intents classified by their
 * EFFECT, never an allowlist of named actions (decision D1). Unknown or
 * unclassifiable intents escalate to act_sensitive.
 */

import {
  BrowserAction,
  ControlPolicyDecision,
  ControlTrustLevel,
  DesktopAction,
  DesktopElement,
  EffectLevel,
  SnapshotElement,
} from "./types";

/** A control intent as policy sees it — intent-level fields only. */
export type ControlIntent =
  | { tool: "screen_view" }
  | { tool: "browser_read" }
  | {
      tool: "browser_act";
      action: BrowserAction;
      /**
       * The snapshot element a ref-based action targets, resolved by the
       * executor from the LAST snapshot. Undefined means the ref is unknown
       * (stale or never seen) — which classifies as act_sensitive.
       */
      element?: SnapshotElement;
    }
  | { tool: "desktop_read" }
  | {
      tool: "desktop_act";
      action: DesktopAction;
      /**
       * The outline element an invoke/set_value targets, resolved by the
       * executor from the LAST desktop_read. Undefined = unknown/stale ref
       * ⇒ act_sensitive (§9.1).
       */
      element?: DesktopElement;
      /** open_app: launch arguments are present. */
      hasArgs?: boolean;
      /**
       * open_app: every argument is an existing file/dir path, validated by
       * TRUSTED application code (fs, never the model). Anything else is
       * command execution ⇒ act_sensitive (D10).
       */
      argsAreExistingPaths?: boolean;
      /**
       * type: the call also presses Enter (types-and-submits atomically),
       * which commits a command ⇒ act_sensitive, exactly like a standalone
       * `keys enter` — but with no half-typed state left behind.
       */
      submits?: boolean;
    }
  | { tool: "control_code" };

// ── Session grants (§4.1) ────────────────────────────────────────────
// In-memory per process: a grant covers act_reversible intents for the rest
// of the session; session end (process exit) revokes it. No persistent
// pending state is needed for fast-lane intents (§8.2).

const sessionGrants = new Set<string>();

export function hasControlSessionGrant(sessionId: string): boolean {
  return sessionGrants.has(sessionId);
}

export function grantControlSession(sessionId: string): void {
  sessionGrants.add(sessionId);
}

export function revokeControlSession(sessionId: string): void {
  sessionGrants.delete(sessionId);
}

/** Test hook — clears every grant. */
export function resetControlSessionGrants(): void {
  sessionGrants.clear();
}

/**
 * Command-execution intents (§9.2, D10): running a shell command or launching
 * with a command. Live finding 2026-07-14: gating each command individually
 * was unusable by voice (the model rarely resends with confirmed=true, so the
 * user looped saying "vas-y" with nothing running). These are now covered by
 * the SINGLE session grant ("je prends la main"), alongside reversible
 * actions — one consent, then commands flow. close (data loss in the user's
 * own apps) and control_code (raw escape hatch, §9.4) are deliberately NOT
 * grant-covered and keep confirming per action.
 */
function isCommandExecution(intent: ControlIntent): boolean {
  if (intent.tool !== "desktop_act") {
    return false;
  }
  if (intent.action === "type") {
    return intent.submits === true;
  }
  if (intent.action === "open_app") {
    return intent.hasArgs === true && intent.argsAreExistingPaths !== true;
  }
  return false;
}

/**
 * What the one session-level "take control" consent covers. Commands keep
 * their sensitive effect classification for `confirm_each`, but under
 * `session_grant` they share the same grant as reversible UI actions. Bare
 * key/chord calls stay outside this lane because they can encode destructive
 * shortcuts (Alt+F4, Ctrl+W, Delete); terminal commands use atomic
 * type+submit instead.
 */
function isCoveredBySessionGrant(
  intent: ControlIntent,
  effectLevel: EffectLevel
): boolean {
  return effectLevel === "act_reversible" || isCommandExecution(intent);
}

// ── Effect classification (§8.1) ─────────────────────────────────────

const REVERSIBLE_ACTIONS: ReadonlySet<BrowserAction> = new Set([
  "fill",
  "select",
  "navigate",
  "open_tab",
  "activate_tab",
  "scroll_to",
]);

export function classifyEffect(intent: ControlIntent): EffectLevel {
  if (
    intent.tool === "screen_view" ||
    intent.tool === "browser_read" ||
    intent.tool === "desktop_read"
  ) {
    return "observe";
  }
  if (intent.tool === "control_code") {
    // Generated code is unbounded by construction — the strictest gate (D2).
    return "act_sensitive";
  }
  if (intent.tool === "desktop_act") {
    return classifyDesktopAction(intent);
  }

  const { action } = intent;
  if (action === "click") {
    return classifyClick(intent.element);
  }
  if (REVERSIBLE_ACTIONS.has(action)) {
    return "act_reversible";
  }
  // close_tab and anything unknown: destructive/committing ⇒ sensitive.
  return "act_sensitive";
}

/**
 * Desktop table (§9.2): opening apps/documents, focusing, typing literal
 * text, and ref-verified UIA actions are reversible; command execution
 * (open_app with non-path args, D10), keys (Enter/chords), close, and
 * unknown refs commit or destroy ⇒ sensitive.
 */
function classifyDesktopAction(
  intent: Extract<ControlIntent, { tool: "desktop_act" }>
): EffectLevel {
  switch (intent.action) {
    case "open_app":
      return intent.hasArgs && !intent.argsAreExistingPaths
        ? "act_sensitive"
        : "act_reversible";
    case "type":
      // Typing literal text is reversible; typing AND submitting commits a
      // command, so it is sensitive like a bare `keys enter` (§9.2, D9/D10).
      return intent.submits ? "act_sensitive" : "act_reversible";
    case "focus":
      return "act_reversible";
    case "invoke":
    case "set_value":
      return intent.element ? "act_reversible" : "act_sensitive";
    case "close":
    case "keys":
    default:
      return "act_sensitive";
  }
}

/**
 * A click that submits is act_sensitive (§8.1): explicit type=submit, or a
 * form-embedded button whose DOM type defaults to submit. An unknown element
 * (stale/unseen ref) is unclassifiable ⇒ act_sensitive.
 */
function classifyClick(element: SnapshotElement | undefined): EffectLevel {
  if (!element) {
    return "act_sensitive";
  }
  const state = element.state ?? {};
  if (state.type === "submit") {
    return "act_sensitive";
  }
  if (state.inForm && element.role === "button" && state.type !== "button") {
    return "act_sensitive";
  }
  return "act_reversible";
}

// ── Trust-level decisions (§8.2) ─────────────────────────────────────

export interface ControlPolicyInput {
  intent: ControlIntent;
  trustLevel: ControlTrustLevel;
  /** Trusted session id from the application, never from the model. */
  sessionId: string;
  /** Trusted application approval; never sourced from model parameters. */
  confirmed: boolean;
  /**
   * CONTROL_CODE_AUTO (§8.2): control_code stays confirmed even under the
   * `auto` trust level unless this is explicitly enabled. Supplied by the
   * tool from configuration; defaults to false.
   */
  controlCodeAuto?: boolean;
}

/**
 * Evaluate a fast-lane control intent. `needs_grant` / `needs_confirmation`
 * outcomes are relayed by the tool to the conversational agent. The runtime
 * stores the exact blocked call and resumes it with trusted approval after an
 * explicit yes (§8.2); the model never supplies the approval bit.
 *
 * A confirmed retry under `session_grant` also records the session grant, so
 * subsequent reversible actions run without asking again (§4.1).
 */
export function evaluateControlIntent(
  input: ControlPolicyInput
): ControlPolicyDecision {
  const effectLevel = classifyEffect(input.intent);

  if (effectLevel === "observe") {
    return { outcome: "allowed", effectLevel, reason: "" };
  }

  if (input.trustLevel === "auto") {
    // §8.2: `auto` skips confirmations — except control_code, which stays
    // individually confirmed unless CONTROL_CODE_AUTO is explicitly set.
    if (
      input.intent.tool === "control_code" &&
      !input.controlCodeAuto &&
      !input.confirmed
    ) {
      return {
        outcome: "needs_confirmation",
        effectLevel,
        reason:
          "Generated code requires an individual confirmation even under the auto " +
          "trust level (set CONTROL_CODE_AUTO=true to change this). Relay the " +
          "rationale and a plain-language summary, then stop; the runtime resumes " +
          "the exact call after an explicit yes.",
      };
    }
    return { outcome: "allowed", effectLevel, reason: "" };
  }

  const coveredBySessionGrant = isCoveredBySessionGrant(
    input.intent,
    effectLevel
  );

  if (input.confirmed) {
    // Only a confirmation for a grant-covered action establishes the broad
    // session consent. Confirming a destructive action (close/control_code)
    // authorizes that call alone; it must not silently grant later control.
    if (
      input.trustLevel === "session_grant" &&
      coveredBySessionGrant
    ) {
      grantControlSession(input.sessionId);
    }
    return { outcome: "allowed", effectLevel, reason: "" };
  }

  if (coveredBySessionGrant && input.trustLevel === "session_grant") {
    if (hasControlSessionGrant(input.sessionId)) {
      return { outcome: "allowed", effectLevel, reason: "" };
    }
    return {
      outcome: "needs_grant",
      effectLevel,
      reason:
        "First acting intent of this session: ask the user once, in their language, " +
        'something like "Je prends la main quand il faut pour cette session ?". ' +
        "Then stop. The runtime will resume this exact call after an explicit yes, " +
        "granting reversible actions and ordinary command execution for the rest " +
        "of the session; do not ask again for each command.",
    };
  }

  return {
    outcome: "needs_confirmation",
    effectLevel,
    reason: effectLevel === "act_sensitive"
        ? "Sensitive action: describe its CONCRETE effect to the user (what closes) — " +
          "never a generic permission question — then stop. The runtime resumes " +
          "the exact call after an explicit yes. This one is confirmed each time."
        : "Trust level confirm_each: describe the concrete action to the user and " +
          "stop; the runtime resumes the exact call after an explicit yes.",
  };
}
