/**
 * Delegation types — backend-neutral task, capability, event, and result
 * types for coding-agent delegation.
 *
 * Phase C2a (docs/phase-c2-coding-agent-delegation.md §4, §5, §8).
 */

export type BackendName = "codex" | "claude";
export type BackendChoice = BackendName | "auto";

export type DelegationCapability =
  | "read_only"
  | "workspace_write"
  | "external_action";

export type ExecutionMode = "prepare" | "run";
export type DelegationContextScope = "none" | "conversation";

/** What the conversational agent asks for via delegate_task (§5.1). */
export interface DelegationRequest {
  task: string;
  capability: DelegationCapability;
  backend: BackendChoice;
  /** Absolute workspace path; must resolve inside an allowed root. */
  workspace?: string;
  webResearch: boolean;
  execution: ExecutionMode;
  timeoutMinutes?: number;
  sessionId?: string;
  /** Trusted, app-supplied conversation window; never accepted from tool params. */
  conversationTranscript?: string;
  contextScope?: DelegationContextScope;
  /** One-sentence focus pointer, bounded again by the service. */
  contextHint?: string;
  /** Memory episode ids already selected by the conversational layer. */
  memoryRefs?: string[];
}

/** Immediate structured result of delegate_task (§5.1). */
export interface DispatchResult {
  taskId: string | null;
  status: "running" | "pending_approval" | "rejected";
  backend: BackendName | null;
  message: string;
  warnings?: string[];
}

/** Compact progress event published by a running task (§3.1). */
export interface DelegationProgressEvent {
  at: string;
  text: string;
}

/** Resolved delegation configuration (§13). */
export interface DelegationConfig {
  enabled: boolean;
  defaultBackend: BackendChoice;
  codexPath?: string;
  claudePath?: string;
  /** Canonical roots eligible for delegation. */
  allowedRoots: string[];
  /**
   * Agent-owned deliverable roots (C2d §3–§4): workspaces inside these run
   * write tasks directly, guarded by Git checkpoints, instead of a worktree.
   * Must each be inside `allowedRoots` (enforced at config load).
   */
  agentOwnedRoots: string[];
  maxConcurrent: number;
  defaultTimeoutMinutes: number;
  maxTimeoutMinutes: number;
  maxOutputBytes: number;
  artifactRetentionDays: number;
  /** Program names allowed for manifest `execute` actions (C2c §6.2). */
  allowedPrograms: string[];
  /** Optional background briefing provider/model overrides (C2d-3). */
  briefProvider?: "google" | "github" | "ollama";
  briefModel?: string;
}

export interface BriefingGeneratorInput {
  task: string;
  transcript: string;
  hint?: string;
}

/** Injectable so delegation tests never make a network LLM call. */
export interface BriefingGenerator {
  generate(input: BriefingGeneratorInput): Promise<string>;
}

/** Result of a policy evaluation (§6). */
export type PolicyDecision =
  | { outcome: "allowed" }
  | { outcome: "pending_approval"; reason: string }
  | { outcome: "rejected"; reason: string };

// ── Backend adapter contract (§8.1) ──────────────────────────────────

export interface BackendAvailability {
  name: BackendName;
  available: boolean;
  version?: string;
  executablePath?: string;
  problem?: string;
}

/** Everything a backend needs to start one supervised run. */
export interface BackendRunContext {
  taskId: string;
  workspace: string;
  capability: DelegationCapability;
  webResearch: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Per-task directory for raw event logs and generated artifacts. */
  artifactDir: string;
  onProgress: (event: DelegationProgressEvent) => void;
}

/** Terminal outcome of one backend run. */
export interface BackendRunOutcome {
  ok: boolean;
  /**
   * The delegated agent's final message. Untrusted tool output — must be
   * delimited before being shown to the conversational model (§11).
   */
  summary: string;
  exitCode: number | null;
  backendSessionId?: string;
  error?: string;
}

/** Handle on a started run. */
export interface RunningAgent {
  pid: number | undefined;
  wait: Promise<BackendRunOutcome>;
  /** Terminates the complete child process tree. */
  cancel(): Promise<void>;
}

export interface ICodingAgentBackend {
  readonly name: BackendName;
  /** Check executable availability without starting a paid task. */
  detect(): Promise<BackendAvailability>;
  /** Start a supervised non-interactive run. */
  start(context: BackendRunContext, task: string): Promise<RunningAgent>;
}
