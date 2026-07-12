/**
 * Action manifests — the machine-readable contract between the prepare and
 * apply stages of an `external_action` delegated task.
 *
 * Phase C2c (docs/phase-c2-coding-agent-delegation.md §3.3, §6, §17). The
 * prepare stage writes `manifest.json` (plus payload files) into the task's
 * plan directory; the application validates it, the user approves it, and
 * the application itself applies exactly the listed actions — the delegated
 * agent never touches user data directly. "Apply cannot exceed the manifest"
 * therefore holds by construction. If the workspace no longer matches an
 * action's preconditions at apply time, execution stops and reports instead
 * of improvising (§3.3 material-difference rule).
 */

import * as fs from "fs";
import * as path from "path";
import { runSupervisedProcess } from "./processRunner";

/** Hard budgets keeping manifests bounded and reviewable. */
export const MANIFEST_MAX_ACTIONS = 500;
export const MANIFEST_MAX_ARGS = 32;
export const MANIFEST_MAX_ARG_CHARS = 400;
export const MANIFEST_MAX_BYTES = 1024 * 1024;
/** Bounded human-readable plan summary (approval request / delivery). */
export const MANIFEST_MAX_SUMMARY_CHARS = 900;
/** Bounded apply report kept in the task record. */
export const APPLY_MAX_REPORT_CHARS = 2000;

export type ManifestAction =
  | { type: "create_dir"; path: string }
  | { type: "create"; path: string; from: string; overwrite?: boolean }
  | { type: "move"; path: string; to: string; overwrite?: boolean }
  | { type: "copy"; path: string; to: string; overwrite?: boolean }
  | { type: "delete"; path: string }
  | { type: "execute"; program: string; script?: string; args?: string[] };

export interface ActionManifest {
  version: 1;
  /** The preparing agent's one-paragraph description of the plan. */
  summary?: string;
  actions: ManifestAction[];
}

export interface ManifestContext {
  /** Canonical target workspace all `path`/`to` values resolve against. */
  workspace: string;
  /** Canonical plan directory `from`/`script` values resolve against. */
  planDir: string;
  /** Program names (basenames) allowed for `execute` actions (§6.2). */
  allowedPrograms: string[];
}

export type ManifestValidation =
  | { ok: true; manifest: ActionManifest }
  | { ok: false; reason: string };

// ── Path containment ─────────────────────────────────────────────────

function normalizeForCompare(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isInside(base: string, resolved: string): boolean {
  const b = normalizeForCompare(base);
  const r = normalizeForCompare(resolved);
  return r === b || r.startsWith(b + path.sep);
}

/**
 * Resolve a manifest-relative path against `base`, rejecting absolute paths
 * and any `..` escape. Lexical check — apply-time preconditions add a
 * realpath check so a symlinked directory inside the workspace cannot
 * smuggle an action outside it.
 */
function resolveInside(
  base: string,
  relative: unknown,
  label: string
): { ok: true; resolved: string } | { ok: false; reason: string } {
  if (typeof relative !== "string" || relative.trim().length === 0) {
    return { ok: false, reason: `${label} must be a non-empty relative path.` };
  }
  if (relative.includes("\0")) {
    return { ok: false, reason: `${label} contains a null byte.` };
  }
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    return { ok: false, reason: `${label} must be relative, got "${relative}".` };
  }
  const normalized = path.normalize(relative);
  if (
    normalized === ".." ||
    normalized.startsWith(".." + path.sep) ||
    normalized.split(path.sep).includes("..")
  ) {
    return { ok: false, reason: `${label} escapes its base directory: "${relative}".` };
  }
  const resolved = path.resolve(base, normalized);
  if (!isInside(base, resolved)) {
    return { ok: false, reason: `${label} escapes its base directory: "${relative}".` };
  }
  return { ok: true, resolved };
}

/**
 * Realpath containment for an apply-time target: the deepest existing
 * ancestor of `resolved` must canonicalize inside `base`, so symlinks or
 * junctions planted inside the workspace cannot redirect an action outside.
 */
function realpathStaysInside(base: string, resolved: string): boolean {
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      return false;
    }
    probe = parent;
  }
  let realBase: string;
  let realProbe: string;
  try {
    realBase = fs.realpathSync(base);
    realProbe = fs.realpathSync(probe);
  } catch {
    return false;
  }
  return isInside(realBase, realProbe);
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Parse and validate raw manifest JSON against the schema, path containment,
 * and the program allowlist. Never throws.
 */
export function validateManifest(
  raw: string,
  context: ManifestContext
): ManifestValidation {
  if (Buffer.byteLength(raw, "utf-8") > MANIFEST_MAX_BYTES) {
    return { ok: false, reason: "manifest.json exceeds the size limit." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `manifest.json is not valid JSON: ${msg}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "manifest.json must be a JSON object." };
  }

  const doc = parsed as Record<string, unknown>;
  if (doc.version !== 1) {
    return { ok: false, reason: `unsupported manifest version: ${String(doc.version)}.` };
  }
  if (!Array.isArray(doc.actions) || doc.actions.length === 0) {
    return { ok: false, reason: "manifest must declare a non-empty actions array." };
  }
  if (doc.actions.length > MANIFEST_MAX_ACTIONS) {
    return {
      ok: false,
      reason: `manifest declares ${doc.actions.length} actions; the limit is ${MANIFEST_MAX_ACTIONS}.`,
    };
  }

  const actions: ManifestAction[] = [];
  for (let i = 0; i < doc.actions.length; i++) {
    const result = validateAction(doc.actions[i], i, context);
    if (!result.ok) {
      return result;
    }
    actions.push(result.action);
  }

  return {
    ok: true,
    manifest: {
      version: 1,
      summary: typeof doc.summary === "string" ? doc.summary.slice(0, 600) : undefined,
      actions,
    },
  };
}

function validateAction(
  raw: unknown,
  index: number,
  context: ManifestContext
): { ok: true; action: ManifestAction } | { ok: false; reason: string } {
  const at = `actions[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: `${at} must be an object.` };
  }
  const action = raw as Record<string, unknown>;
  const type = typeof action.type === "string" ? action.type : "";

  const workspacePath = (field: "path" | "to") =>
    resolveInside(context.workspace, action[field], `${at}.${field}`);
  const planPath = (field: "from" | "script") =>
    resolveInside(context.planDir, action[field], `${at}.${field}`);

  switch (type) {
    case "create_dir": {
      const p = workspacePath("path");
      if (!p.ok) return p;
      return { ok: true, action: { type, path: String(action.path) } };
    }
    case "create": {
      const p = workspacePath("path");
      if (!p.ok) return p;
      const from = planPath("from");
      if (!from.ok) return from;
      if (!fs.existsSync(from.resolved) || !fs.statSync(from.resolved).isFile()) {
        return {
          ok: false,
          reason: `${at}.from payload file is missing in the plan directory: "${String(action.from)}".`,
        };
      }
      return {
        ok: true,
        action: {
          type,
          path: String(action.path),
          from: String(action.from),
          overwrite: action.overwrite === true,
        },
      };
    }
    case "move":
    case "copy": {
      const p = workspacePath("path");
      if (!p.ok) return p;
      const to = workspacePath("to");
      if (!to.ok) return to;
      return {
        ok: true,
        action: {
          type,
          path: String(action.path),
          to: String(action.to),
          overwrite: action.overwrite === true,
        },
      };
    }
    case "delete": {
      const p = workspacePath("path");
      if (!p.ok) return p;
      return { ok: true, action: { type, path: String(action.path) } };
    }
    case "execute": {
      const program = typeof action.program === "string" ? action.program.trim() : "";
      if (!program || program !== path.basename(program)) {
        return {
          ok: false,
          reason: `${at}.program must be a bare program name, got "${program}".`,
        };
      }
      const allowed = context.allowedPrograms.some(
        (p) => p.toLowerCase() === program.toLowerCase()
      );
      if (!allowed) {
        return {
          ok: false,
          reason:
            `${at}.program "${program}" is not in the allowed-programs list` +
            (context.allowedPrograms.length > 0
              ? ` (${context.allowedPrograms.join(", ")}).`
              : " (the list is empty — configure DELEGATION_ALLOWED_PROGRAMS)."),
        };
      }
      let script: string | undefined;
      if (action.script !== undefined) {
        const s = planPath("script");
        if (!s.ok) return s;
        if (!fs.existsSync(s.resolved) || !fs.statSync(s.resolved).isFile()) {
          return {
            ok: false,
            reason: `${at}.script is missing in the plan directory: "${String(action.script)}".`,
          };
        }
        script = String(action.script);
      }
      const rawArgs = action.args ?? [];
      if (!Array.isArray(rawArgs) || rawArgs.length > MANIFEST_MAX_ARGS) {
        return { ok: false, reason: `${at}.args must be an array of at most ${MANIFEST_MAX_ARGS} strings.` };
      }
      const args: string[] = [];
      for (const arg of rawArgs) {
        if (typeof arg !== "string" || arg.length > MANIFEST_MAX_ARG_CHARS) {
          return {
            ok: false,
            reason: `${at}.args entries must be strings of at most ${MANIFEST_MAX_ARG_CHARS} characters.`,
          };
        }
        args.push(arg);
      }
      return { ok: true, action: { type, program, script, args } };
    }
    default:
      return {
        ok: false,
        reason: `${at}.type "${type}" is not supported (create_dir, create, move, copy, delete, execute).`,
      };
  }
}

// ── Human-readable summary ───────────────────────────────────────────

function describeAction(action: ManifestAction): string {
  switch (action.type) {
    case "create_dir":
      return `create directory "${action.path}"`;
    case "create":
      return `create "${action.path}"${action.overwrite ? " (overwrite)" : ""}`;
    case "move":
      return `move "${action.path}" -> "${action.to}"${action.overwrite ? " (overwrite)" : ""}`;
    case "copy":
      return `copy "${action.path}" -> "${action.to}"${action.overwrite ? " (overwrite)" : ""}`;
    case "delete":
      return `delete "${action.path}"`;
    case "execute":
      return `run ${action.program}${action.script ? ` ${action.script}` : ""}${
        action.args && action.args.length > 0 ? ` (${action.args.length} arg(s))` : ""
      }`;
  }
}

/**
 * Bounded plan description used for the approval request and delivery — the
 * concrete effects the user is asked to approve (§3.2).
 */
export function summarizeManifest(manifest: ActionManifest): string {
  const shown = 12;
  const lines: string[] = [];
  if (manifest.summary) {
    lines.push(manifest.summary.trim());
  }
  lines.push(`${manifest.actions.length} action(s):`);
  for (const action of manifest.actions.slice(0, shown)) {
    lines.push(`  - ${describeAction(action)}`);
  }
  if (manifest.actions.length > shown) {
    lines.push(`  … and ${manifest.actions.length - shown} more.`);
  }
  const text = lines.join("\n");
  return text.length > MANIFEST_MAX_SUMMARY_CHARS
    ? `${text.slice(0, MANIFEST_MAX_SUMMARY_CHARS)}…`
    : text;
}

// ── Apply ────────────────────────────────────────────────────────────

export interface ApplyOptions extends ManifestContext {
  /** Per-task directory receiving execute-action output logs. */
  artifactDir: string;
  /** Overall budget shared by execute actions. */
  timeoutMs: number;
  maxOutputBytes: number;
  /** Checked between actions; a true value stops the apply cleanly. */
  isCancelled?: () => boolean;
  /** Lets the caller cancel a running execute-action child process. */
  onExecProcess?: (cancel: () => Promise<void>) => void;
}

export interface ApplyResult {
  ok: boolean;
  appliedCount: number;
  totalCount: number;
  /** Bounded per-action report. */
  report: string;
  /** Stop reason when not ok. */
  error?: string;
}

/**
 * Apply a validated manifest to the workspace, action by action, verifying
 * each action's preconditions first and its outcome afterwards. Stops at the
 * first divergence; already-applied actions are reported, never undone
 * automatically (§5.4).
 */
export async function applyManifest(
  manifest: ActionManifest,
  options: ApplyOptions
): Promise<ApplyResult> {
  const lines: string[] = [];
  let applied = 0;

  const done = (ok: boolean, error?: string): ApplyResult => {
    if (error) {
      lines.push(`stopped: ${error}`);
    }
    const report = lines.join("\n");
    return {
      ok,
      appliedCount: applied,
      totalCount: manifest.actions.length,
      report:
        report.length > APPLY_MAX_REPORT_CHARS
          ? `${report.slice(0, APPLY_MAX_REPORT_CHARS)}…`
          : report,
      error,
    };
  };

  for (let i = 0; i < manifest.actions.length; i++) {
    if (options.isCancelled?.()) {
      return done(false, "cancelled by user before all actions were applied.");
    }
    const action = manifest.actions[i];
    const label = `actions[${i}] ${describeAction(action)}`;
    try {
      const error = await applyOneAction(action, options);
      if (error) {
        return done(false, `${label} — ${error}`);
      }
      applied++;
      lines.push(`applied: ${describeAction(action)}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return done(false, `${label} — ${msg}`);
    }
  }

  return done(true);
}

/** Returns an error string when the action cannot proceed; null on success. */
async function applyOneAction(
  action: ManifestAction,
  options: ApplyOptions
): Promise<string | null> {
  const inWorkspace = (rel: string): string | null => {
    const resolved = path.resolve(options.workspace, path.normalize(rel));
    if (!isInside(options.workspace, resolved)) {
      return null;
    }
    if (!realpathStaysInside(options.workspace, resolved)) {
      return null;
    }
    return resolved;
  };

  switch (action.type) {
    case "create_dir": {
      const target = inWorkspace(action.path);
      if (!target) return "target escapes the workspace.";
      fs.mkdirSync(target, { recursive: true });
      if (!fs.statSync(target).isDirectory()) return "verification failed: not a directory.";
      return null;
    }

    case "create": {
      const target = inWorkspace(action.path);
      if (!target) return "target escapes the workspace.";
      const from = path.resolve(options.planDir, path.normalize(action.from));
      if (!isInside(options.planDir, from) || !fs.existsSync(from)) {
        return "payload file disappeared from the plan directory.";
      }
      if (fs.existsSync(target) && !action.overwrite) {
        return "target already exists and overwrite was not approved.";
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(from, target);
      if (!fs.existsSync(target)) return "verification failed: target missing after create.";
      return null;
    }

    case "move":
    case "copy": {
      const source = inWorkspace(action.path);
      const dest = inWorkspace(action.to);
      if (!source || !dest) return "source or destination escapes the workspace.";
      if (!fs.existsSync(source)) {
        return "source no longer exists — the workspace changed since the plan was approved.";
      }
      if (fs.existsSync(dest) && !action.overwrite) {
        return "destination already exists and overwrite was not approved.";
      }
      if (action.type === "copy" && !fs.statSync(source).isFile()) {
        return "copy supports files only — list directory contents explicitly.";
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (action.type === "copy") {
        fs.copyFileSync(source, dest);
      } else {
        fs.renameSync(source, dest);
        if (fs.existsSync(source)) return "verification failed: source still present after move.";
      }
      if (!fs.existsSync(dest)) return "verification failed: destination missing.";
      return null;
    }

    case "delete": {
      const target = inWorkspace(action.path);
      if (!target) return "target escapes the workspace.";
      if (!fs.existsSync(target)) {
        return "target no longer exists — the workspace changed since the plan was approved.";
      }
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        if (fs.readdirSync(target).length > 0) {
          return "refusing to delete a non-empty directory — the manifest must list its contents explicitly.";
        }
        fs.rmdirSync(target);
      } else {
        fs.unlinkSync(target);
      }
      if (fs.existsSync(target)) return "verification failed: target still present after delete.";
      return null;
    }

    case "execute": {
      // Allowlist re-checked at apply time so a config change between
      // approval and apply cannot widen the grant.
      const allowed = options.allowedPrograms.some(
        (p) => p.toLowerCase() === action.program.toLowerCase()
      );
      if (!allowed) return `program "${action.program}" is no longer in the allowed list.`;
      const args: string[] = [];
      if (action.script) {
        const script = path.resolve(options.planDir, path.normalize(action.script));
        if (!isInside(options.planDir, script) || !fs.existsSync(script)) {
          return "script disappeared from the plan directory.";
        }
        args.push(script);
      }
      args.push(...(action.args ?? []));

      const logFile = path.join(
        options.artifactDir,
        `apply-exec-${Date.now().toString(36)}.log`
      );
      const log = (line: string): void => {
        try {
          fs.appendFileSync(logFile, line + "\n", "utf-8");
        } catch {
          // logging must never fail the apply
        }
      };

      const proc = runSupervisedProcess({
        executable: action.program,
        args,
        cwd: options.workspace,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        onStdoutLine: log,
        onStderrLine: (line) => log(`[stderr] ${line}`),
      });
      options.onExecProcess?.(() => proc.cancel());
      const outcome = await proc.wait;
      if (outcome.error) return outcome.error;
      if (outcome.cancelled) return "cancelled by user.";
      if (outcome.timedOut) return "timed out.";
      if (outcome.exitCode !== 0) {
        return `${action.program} exited with code ${outcome.exitCode} (log: ${logFile}).`;
      }
      return null;
    }
  }
}
