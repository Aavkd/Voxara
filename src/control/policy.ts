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
    };

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
  if (intent.tool === "screen_view" || intent.tool === "browser_read") {
    return "observe";
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
  /** True when the model retries after the user's explicit yes. */
  confirmed: boolean;
}

/**
 * Evaluate a fast-lane control intent. `needs_grant` / `needs_confirmation`
 * outcomes are relayed by the tool to the conversational agent, which asks
 * the user with the concrete effect and retries the same call with
 * confirmed=true after an explicit yes (§8.2).
 *
 * A confirmed retry under `session_grant` also records the session grant, so
 * subsequent reversible actions run without asking again (§4.1).
 */
export function evaluateControlIntent(
  input: ControlPolicyInput
): ControlPolicyDecision {
  const effectLevel = classifyEffect(input.intent);

  if (effectLevel === "observe" || input.trustLevel === "auto") {
    return { outcome: "allowed", effectLevel, reason: "" };
  }

  if (input.confirmed) {
    if (effectLevel === "act_reversible" && input.trustLevel === "session_grant") {
      grantControlSession(input.sessionId);
    }
    return { outcome: "allowed", effectLevel, reason: "" };
  }

  if (effectLevel === "act_reversible" && input.trustLevel === "session_grant") {
    if (hasControlSessionGrant(input.sessionId)) {
      return { outcome: "allowed", effectLevel, reason: "" };
    }
    return {
      outcome: "needs_grant",
      effectLevel,
      reason:
        "First acting intent of this session: ask the user once, in their language, " +
        'something like "Je prends la main quand il faut pour cette session ?". ' +
        "On an explicit yes, retry the SAME call with confirmed=true — that grants " +
        "reversible actions for the rest of the session.",
    };
  }

  return {
    outcome: "needs_confirmation",
    effectLevel,
    reason:
      effectLevel === "act_sensitive"
        ? "Sensitive action: describe its CONCRETE effect to the user (what closes, " +
          "what gets submitted) — never a generic permission question — and retry " +
          "the same call with confirmed=true only after an explicit yes."
        : "Trust level confirm_each: describe the concrete action to the user and " +
          "retry the same call with confirmed=true after an explicit yes.",
  };
}
