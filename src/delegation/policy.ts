/**
 * Delegation policy engine — allowed roots, capability decisions,
 * concurrency, and budgets.
 *
 * Phase C2a/C2b/C2c (docs/phase-c2-coding-agent-delegation.md §6, §7, §9).
 *
 * Slice note: C2a enables `read_only` (optionally with `web_research`).
 * C2b enables `workspace_write` for Git repositories only — the run happens
 * in an isolated detached worktree (§7), so the user's main tree is never
 * touched; the diff is reported for review. C2c enables `external_action`
 * as a two-stage flow: the prepare stage may start directly (it only writes
 * a manifest into the plan directory), while the apply stage always waits
 * for explicit approval via delegate_approve (§3.3). Non-Git user-data
 * workflows go through that same prepare/apply path.
 */

import { TaskRecord } from "../engine/taskStore";
import {
  DelegationConfig,
  DelegationRequest,
  PolicyDecision,
} from "./types";
import { canonicalizeWorkspace, isInsideAllowedRoots } from "./workspace";
import { getGitRepoRoot } from "./worktree";
import { findAgentOwnedRoot } from "./agentWorkspace";

/**
 * Evaluate a delegation request against configuration and currently active
 * tasks. Returns allowed / pending_approval / rejected with a reason the
 * conversational agent can relay to the user.
 */
export function evaluateDelegationRequest(
  request: DelegationRequest,
  config: DelegationConfig,
  activeTasks: TaskRecord[]
): PolicyDecision {
  if (!config.enabled) {
    return {
      outcome: "rejected",
      reason:
        "Delegation is disabled. Set DELEGATION_ENABLED=true and configure " +
        "DELEGATION_ALLOWED_ROOTS, then run `llmtest delegates doctor` to verify setup.",
    };
  }

  if (!request.task || request.task.trim().length === 0) {
    return { outcome: "rejected", reason: "task must be a non-empty objective." };
  }

  const validCapabilities = ["read_only", "workspace_write", "external_action"];
  if (!validCapabilities.includes(request.capability)) {
    return {
      outcome: "rejected",
      reason: `unknown capability "${request.capability}". Valid: ${validCapabilities.join(", ")}.`,
    };
  }

  // §5.1: the execution mode is an app-owned enum, and the two-stage
  // prepare/apply flow only exists for external_action (§3.3).
  if (request.execution !== "run" && request.execution !== "prepare") {
    return {
      outcome: "rejected",
      reason: `unknown execution mode "${request.execution}". Valid: run, prepare.`,
    };
  }
  if (request.execution === "prepare" && request.capability !== "external_action") {
    return {
      outcome: "rejected",
      reason:
        "execution=prepare only applies to external_action tasks (prepare/apply " +
        "manifest flow). read_only and workspace_write tasks always use execution=run.",
    };
  }

  // §6.1: web_research pairs only with read_only in v1.
  if (request.webResearch && request.capability !== "read_only") {
    return {
      outcome: "rejected",
      reason:
        "web_research can only be combined with read_only. Split the task in two: " +
        "a read-only research task, then a separate workspace task.",
    };
  }

  // Agent-owned class detection (C2d §3): a write workspace inside an
  // agent-owned root runs directly with Git checkpoints — no worktree, no
  // pre-existing-repo requirement (the service bootstraps the root), and the
  // path may not exist yet (the service creates it inside the root).
  const agentOwnedRoot =
    request.capability === "workspace_write" && request.workspace
      ? findAgentOwnedRoot(request.workspace, config.agentOwnedRoots)
      : null;

  // Workspace validation — skipped for web research, which always gets an
  // empty per-task scratch directory instead of a user root (§6.1).
  if (!request.webResearch) {
    if (!request.workspace) {
      return {
        outcome: "rejected",
        reason:
          "workspace is required (or set web_research=true for a scratch workspace).",
      };
    }
    const canonical = canonicalizeWorkspace(request.workspace);
    if (!canonical.ok) {
      // Agent-owned write workspaces may not exist yet — containment in the
      // agent-owned root (itself validated against the allowed roots at
      // config load) was already established above; dispatch creates the
      // directory and re-checks the realpath.
      if (!agentOwnedRoot) {
        return { outcome: "rejected", reason: canonical.reason };
      }
    } else if (
      !isInsideAllowedRoots(canonical.canonicalPath, config.allowedRoots)
    ) {
      return {
        outcome: "rejected",
        reason:
          `workspace "${canonical.canonicalPath}" is outside the allowed delegation roots. ` +
          "Configure DELEGATION_ALLOWED_ROOTS to include it.",
      };
    }
  }

  // Concurrency budget (§13). Running tasks only; pending approvals hold no process.
  const running = activeTasks.filter(
    (t) => t.kind === "coding_agent" && t.status === "running"
  );
  if (running.length >= config.maxConcurrent) {
    return {
      outcome: "rejected",
      reason:
        `delegation is at its concurrency limit (${config.maxConcurrent} running). ` +
        "Wait for a task to finish or cancel one.",
    };
  }

  // One write-capable task per workspace at a time (§7). The lock scope is
  // the whole agent-owned root for direct runs (C2d §4.6) — two writers in
  // two subdirectories of one agent-owned repo are still two writers on one
  // repo — and the exact workspace otherwise.
  if (request.capability !== "read_only" && request.workspace) {
    const requestedScope = writeLockScope(request.workspace, config);
    const writerConflict = running.some(
      (t) =>
        t.capability !== "read_only" &&
        typeof t.workspace === "string" &&
        sameWorkspace(writeLockScope(t.workspace, config), requestedScope)
    );
    if (writerConflict) {
      return {
        outcome: "rejected",
        reason:
          "another write-capable task is already running against this workspace. " +
          "Only one writer per workspace is allowed.",
      };
    }
  }

  // Capability gate (§6). read_only runs directly. workspace_write runs
  // directly too (C2b) — the delegate_task call itself expresses clear user
  // intent to modify, and isolation comes from the detached Git worktree, so
  // the user's main tree is never touched. external_action (C2c) may start
  // its PREPARE stage directly — it only inspects the workspace and writes a
  // manifest into the plan directory; consequential changes stay behind the
  // delegate_approve gate, which the service enforces (§3.3).

  if (request.capability === "workspace_write" && !agentOwnedRoot) {
    // Worktree class only (C2d §3): agent-owned workspaces need no
    // pre-existing repo — the service bootstraps the root and runs directly.
    const canonical = canonicalizeWorkspace(request.workspace!);
    if (!canonical.ok) {
      return { outcome: "rejected", reason: canonical.reason };
    }
    const repoRoot = getGitRepoRoot(canonical.canonicalPath);
    if (!repoRoot) {
      return {
        outcome: "rejected",
        reason:
          "workspace_write requires a Git repository: writes run in an isolated " +
          "worktree and the user's tree stays untouched. Initialize the workspace " +
          "with git (an initial commit is required), or use capability " +
          "external_action for the prepare/apply manifest flow on non-Git data.",
      };
    }
    // A workspace inside the roots whose repository root sits above them
    // would leak the whole repository into the worktree — refuse it.
    if (!isInsideAllowedRoots(repoRoot, config.allowedRoots)) {
      return {
        outcome: "rejected",
        reason:
          `the Git repository root "${repoRoot}" is outside the allowed delegation ` +
          "roots, so an isolated worktree would expose files beyond the approved " +
          "scope. Add the repository root to DELEGATION_ALLOWED_ROOTS to allow it.",
      };
    }
  }

  return { outcome: "allowed" };
}

/**
 * Clamp the requested timeout to the configured budget.
 * Invalid or missing values fall back to the default.
 */
export function resolveTimeoutMinutes(
  requested: number | undefined,
  config: DelegationConfig
): number {
  if (
    requested === undefined ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return config.defaultTimeoutMinutes;
  }
  return Math.min(Math.ceil(requested), config.maxTimeoutMinutes);
}

function sameWorkspace(a: string, b: string): boolean {
  const normalize = (p: string): string =>
    process.platform === "win32" ? p.toLowerCase() : p;
  return normalize(a) === normalize(b);
}

/**
 * The path a write task locks (C2d §4.6): its agent-owned root when it has
 * one, otherwise the workspace itself (canonical when resolvable).
 */
function writeLockScope(workspace: string, config: DelegationConfig): string {
  const agentRoot = findAgentOwnedRoot(workspace, config.agentOwnedRoots);
  if (agentRoot) {
    return agentRoot;
  }
  const canonical = canonicalizeWorkspace(workspace);
  return canonical.ok ? canonical.canonicalPath : workspace;
}
