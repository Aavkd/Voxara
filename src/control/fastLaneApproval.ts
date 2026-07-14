/**
 * Fast-lane approval handoff between conversational turns.
 *
 * A small model cannot be trusted to replay a blocked call with a magic
 * `confirmed:true` argument. The application therefore remembers the EXACT
 * blocked control call, consumes only the next explicit user response, and
 * gives the agent loop that call back for an application-authorized retry.
 */

export interface PendingFastLaneApproval {
  toolName: string;
  toolParams: Record<string, unknown>;
  outcome: "needs_grant" | "needs_confirmation";
}

const CONTROL_TOOLS = new Set(["browser_act", "desktop_act", "control_code"]);
const BLOCKED_PATTERN = /^action_blocked \((needs_grant|needs_confirmation)\)/;
const pendingBySession = new Map<string, PendingFastLaneApproval>();

/** Keep the first blocked action; later model retries must not change its scope. */
export function rememberFastLaneApproval(
  sessionId: string | undefined,
  toolName: string,
  toolParams: Record<string, unknown>,
  result: unknown
): boolean {
  if (!sessionId || !CONTROL_TOOLS.has(toolName) || typeof result !== "string") {
    return false;
  }
  const match = BLOCKED_PATTERN.exec(result);
  if (!match || pendingBySession.has(sessionId)) {
    return false;
  }
  const { confirmed: _modelSuppliedConfirmation, ...originalParams } = toolParams;
  pendingBySession.set(sessionId, {
    toolName,
    toolParams: originalParams,
    outcome: match[1] as PendingFastLaneApproval["outcome"],
  });
  return true;
}

/**
 * Consume the pending request on the very next user turn. An explicit yes
 * returns the exact call to retry; a denial, unrelated answer, or ambiguity
 * cancels it so a later incidental "yes" cannot approve stale work.
 */
export function takeApprovedFastLaneAction(
  sessionId: string | undefined,
  userText: string
): PendingFastLaneApproval | undefined {
  if (!sessionId) {
    return undefined;
  }
  const pending = pendingBySession.get(sessionId);
  if (!pending) {
    return undefined;
  }
  pendingBySession.delete(sessionId);
  return isExplicitAffirmative(userText) ? pending : undefined;
}

export function hasPendingFastLaneApproval(sessionId: string): boolean {
  return pendingBySession.has(sessionId);
}

/** Test/session cleanup hook. */
export function resetFastLaneApprovals(): void {
  pendingBySession.clear();
}

/** Conservative multilingual matcher for a reply to an approval question. */
export function isExplicitAffirmative(text: string): boolean {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’'`-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return false;
  }
  // A reply beginning with a refusal wins even if it later quotes "oui".
  if (/^(non|no|nope|stop|annule|annuler|je refuse|ne le fais pas)\b/.test(normalized)) {
    return false;
  }
  return /\b(oui|yes|ok|okay|d accord|bien sur|vas y|allez y|tu peux|vous pouvez|je confirme|j accepte|j autorise|go ahead|go for it|procede|fais le|faites le|c est bon)\b/.test(
    normalized
  );
}
