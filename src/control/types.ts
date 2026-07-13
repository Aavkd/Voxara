export type ScreenTarget = "screen" | "window" | "browser_tab";

export interface ScreenCaptureRequest {
  target: Exclude<ScreenTarget, "browser_tab">;
  windowTitle?: string;
  maxEdge?: number;
}

export interface ScreenImageResult {
  kind: "image";
  mimeType: "image/png";
  base64: string;
  note?: string;
}

// ── Control policy (C3b, docs/phase-c3-computer-control.md §8) ──────

/** Effect level of an intent — classified by effect, never by target content (D1). */
export type EffectLevel = "observe" | "act_reversible" | "act_sensitive";

/** User-configured trust level (CONTROL_TRUST_LEVEL, §8.2). */
export type ControlTrustLevel = "confirm_each" | "session_grant" | "auto";

export type ControlPolicyOutcome =
  | "allowed"
  | "needs_grant"
  | "needs_confirmation"
  | "rejected";

export interface ControlPolicyDecision {
  outcome: ControlPolicyOutcome;
  effectLevel: EffectLevel;
  /** Relayable reason the conversational agent can pass to the user. */
  reason: string;
}

// ── Browser intents (§7.3) ───────────────────────────────────────────

export type BrowserAction =
  | "click"
  | "fill"
  | "select"
  | "navigate"
  | "open_tab"
  | "activate_tab"
  | "close_tab"
  | "scroll_to";

/**
 * Element state bits the snapshot carries so policy.ts can classify a click
 * (§8.1): a submit-type click or a form-embedded default button is a
 * submission, hence act_sensitive.
 */
export interface SnapshotElementState {
  /** DOM `type` for buttons/inputs (a <button> defaults to "submit"). */
  type?: string;
  /** True when the element sits inside a <form>. */
  inForm?: boolean;
  disabled?: boolean;
  checked?: boolean;
  href?: string;
}

export interface SnapshotElement {
  /** Ephemeral ref, invalidated by navigation or the next snapshot. */
  ref: string;
  role: string;
  name: string;
  value?: string;
  state?: SnapshotElementState;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** Present when the app-side character budget truncated the element list. */
  truncated?: string;
}

export interface BrowserTabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId?: number;
}

// ── Bridge protocol (§7.2) ───────────────────────────────────────────

export type BridgeCommand = "snapshot" | "act" | "navigate" | "tabs" | "screenshot";

export interface BridgeRequest {
  id: string;
  command: BridgeCommand;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BridgeHello {
  type: "hello";
  token: string;
  extensionVersion?: string;
}

// ── Journal (§8.3) ───────────────────────────────────────────────────

export interface ControlJournalEntry {
  timestamp: string;
  sessionId: string;
  lane: "fast" | "pilot";
  intent: string;
  target: string;
  policyDecision: ControlPolicyOutcome;
  outcome: "success" | "error" | "blocked";
  error?: string;
  artifact?: string;
}
