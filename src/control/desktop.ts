/**
 * Desktop executor — routes desktop intents to the persistent PowerShell
 * host and owns the trusted-code responsibilities around it
 * (docs/phase-c3-computer-control.md §9.1–§9.2):
 *
 *  - the UIA outline ref cache that feeds the policy classifier (a ref from
 *    an older host generation is stale ⇒ unknown ⇒ act_sensitive);
 *  - app-name resolution (the model supplies a friendly name, never a path)
 *    with ambiguity relayed instead of guessed;
 *  - validation that open_app args are existing filesystem paths (the
 *    reversible "open a document" case, D10) — checked with fs here, never
 *    trusted from the model;
 *  - the snapshot character budget, mirroring the browser path (§7.4).
 */

import * as fs from "fs";
import { loadControlMaxSnapshotChars } from "../config/loader";
import { getDesktopHost } from "./desktopHost";
import {
  DesktopAction,
  DesktopElement,
  DesktopOutline,
  DesktopWindowInfo,
} from "./types";

/** Subset of DesktopHost the executor needs — injectable in tests. */
export interface DesktopHostLike {
  request<T = unknown>(
    command: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T>;
  readonly generation: number;
  interrupt(): Promise<void>;
}

export interface DesktopActRequest {
  action: DesktopAction;
  /** open_app: friendly app name; focus/close/type/keys: window title substring. */
  target?: string;
  /** open_app only. */
  args?: string[];
  /**
   * open_app disambiguation: one of the `path` values a previous open_app
   * returned in its `candidates` list. Re-validated against a fresh resolve,
   * so the model can only pick from what the trusted resolver offered — it
   * still never invents a path.
   */
  appPath?: string;
  /** invoke / set_value: element ref from the last desktop_read. */
  ref?: string;
  value?: string;
  text?: string;
  /** type: also press Enter after the text, atomically (types-and-submits). */
  submit?: boolean;
  keys?: string;
}

/** Several windows (or apps) matched: relay the candidates, never guess. */
export interface AmbiguousWindows {
  ambiguous: string[];
}

export interface AppCandidate {
  name: string;
  path: string;
  kind: "exe" | "uwp";
}

export interface DesktopExecutor {
  listWindows(): Promise<DesktopWindowInfo[]>;
  readElements(target: string): Promise<DesktopOutline | AmbiguousWindows>;
  act(request: DesktopActRequest): Promise<unknown>;
  /**
   * Element from the LAST outline for policy classification (§9.1).
   * Undefined for a ref never seen, invalidated by a newer read, or minted
   * under a previous host generation (host restart ⇒ stale).
   */
  lookupRef(ref: string): DesktopElement | undefined;
  /** Milliseconds since the user's last mouse/keyboard input (§4.3). */
  idleMs(): Promise<number>;
  /** Abort the in-flight host call (pilot kill-switch, §4.3). */
  interrupt(): Promise<void>;
}

/** True when EVERY launch argument is an existing file/dir path (D10). */
export function argsAreExistingPaths(args: string[]): boolean {
  return args.length > 0 && args.every((arg) => {
    try {
      return fs.existsSync(arg);
    } catch {
      return false;
    }
  });
}

export function createDesktopExecutor(
  host: DesktopHostLike,
  maxSnapshotChars: () => number = loadControlMaxSnapshotChars
): DesktopExecutor {
  let lastOutlineRefs = new Map<string, DesktopElement>();
  let lastOutlineGeneration = -1;
  // The last window Voxara itself launched (§9.2 live fix): subsequent
  // type/keys/focus/close on a matching title reuse THIS exact window by
  // handle instead of re-resolving a title substring — which is what made
  // Voxara type into the user's own dev terminal and re-open new ones.
  let lastLaunch:
    | {
        binding: "bound";
        ref: string;
        title: string;
        process: string;
        requestedTarget: string;
      }
    | { binding: "unbound"; requestedTarget: string }
    | undefined;

  /**
   * Resolve the host-side window selector for a title/ref target. A `w<n>`
   * ref targets that exact window; otherwise, if the target plausibly names
   * the window Voxara just launched, reuse that window's handle; else fall
   * back to the title substring.
   */
  const windowSelector = (
    target?: string,
    protectKeyboardInput = false
  ): { handle?: string; target?: string } => {
    const t = (target ?? "").trim();
    if (/^w\d+$/.test(t)) {
      if (protectKeyboardInput && lastLaunch?.binding === "unbound") {
        throw new Error(
          "the last launched app produced no stable window ref — refusing to type " +
            "into a different window; open the intended app again"
        );
      }
      if (
        protectKeyboardInput &&
        lastLaunch?.binding === "bound" &&
        t !== lastLaunch.ref
      ) {
        throw new Error(
          `ref ${t} is not the window Voxara just opened (${lastLaunch.ref}) — ` +
            "refusing to substitute another window for keyboard input"
        );
      }
      return { handle: t.slice(1) };
    }
    if (protectKeyboardInput && lastLaunch?.binding === "unbound") {
      throw new Error(
        "the last launched app produced no stable window ref — refusing keyboard " +
          "input because it could target an existing user window"
      );
    }
    if (
      lastLaunch?.binding === "bound" &&
      matchesLaunched(t, lastLaunch)
    ) {
      return { handle: lastLaunch.ref.slice(1) };
    }
    return { target: t };
  };

  const rememberLaunched = (result: unknown, requestedTarget: string): void => {
    if (!result || typeof result !== "object") {
      return;
    }
    const r = result as {
      launched?: unknown;
      ref?: string;
      window?: string;
      process?: string;
    };
    if (typeof r.ref === "string" && /^w\d+$/.test(r.ref)) {
      lastLaunch = {
        binding: "bound",
        ref: r.ref,
        title: typeof r.window === "string" ? r.window : "",
        process: typeof r.process === "string" ? r.process : "",
        requestedTarget,
      };
    } else if (r.launched !== undefined) {
      // The launch happened, but no durable top-level handle belongs to it
      // (commonly a UWP activation that reused an existing Windows Terminal).
      // Preserve that provenance so later keyboard calls fail closed.
      lastLaunch = { binding: "unbound", requestedTarget };
    }
  };

  return {
    async listWindows(): Promise<DesktopWindowInfo[]> {
      const windows = await host.request<DesktopWindowInfo[]>("list_windows");
      return Array.isArray(windows) ? windows : [];
    },

    async readElements(target: string): Promise<DesktopOutline | AmbiguousWindows> {
      const raw = await host.request<DesktopOutline | AmbiguousWindows>("elements", {
        target,
        max_elements: 200,
      });
      if (isAmbiguous(raw)) {
        return { ambiguous: raw.ambiguous };
      }
      const bounded = boundOutline(raw, maxSnapshotChars());
      lastOutlineRefs = new Map(bounded.elements.map((el) => [el.ref, el]));
      lastOutlineGeneration = host.generation;
      return bounded;
    },

    async act(request: DesktopActRequest): Promise<unknown> {
      switch (request.action) {
        case "open_app": {
          const result = await openApp(
            host,
            request.target ?? "",
            request.args ?? [],
            request.appPath
          );
          rememberLaunched(result, request.target ?? "");
          return result;
        }
        case "focus":
          return host.request("focus", windowSelector(request.target));
        case "close":
          return host.request("close", windowSelector(request.target));
        case "invoke":
          return host.request("invoke", { ref: request.ref });
        case "set_value":
          return host.request("set_value", { ref: request.ref, value: request.value });
        case "type":
          return host.request(request.submit ? "type_submit" : "type", {
            ...windowSelector(request.target, true),
            text: request.text,
          });
        case "keys":
          return host.request("keys", {
            ...windowSelector(request.target, true),
            keys: request.keys,
          });
        default:
          throw new Error(`unknown desktop action "${String(request.action)}"`);
      }
    },

    lookupRef(ref: string): DesktopElement | undefined {
      // A host restart killed the AutomationElement cache the refs point at.
      if (lastOutlineGeneration !== host.generation) {
        return undefined;
      }
      return lastOutlineRefs.get(ref);
    },

    async idleMs(): Promise<number> {
      const result = await host.request<{ idleMs?: number }>("last_input");
      const idle = result?.idleMs;
      if (typeof idle !== "number" || !Number.isFinite(idle)) {
        throw new Error("the desktop host returned no usable idle time");
      }
      return idle;
    },

    async interrupt(): Promise<void> {
      await host.interrupt();
    },
  };
}

/**
 * Resolve the friendly app name through the host (Start Menu, App Paths,
 * PATH, Store apps — §9.2), then launch. Candidates are RANKED so a clear
 * winner launches automatically (a 64-bit .exe whose name matches beats an
 * x86/ISE/UWP near-duplicate); only a genuine tie is relayed for the user to
 * disambiguate — and then the model retries with `appPath` set to the chosen
 * candidate's path. This is what stops the "which one?" loop where nothing
 * ever launched.
 */
async function openApp(
  host: DesktopHostLike,
  name: string,
  args: string[],
  appPath?: string
): Promise<unknown> {
  const resolved = await host.request<{ candidates?: AppCandidate[] }>("resolve_app", {
    name,
  });
  const wanted = foldName(name);
  const candidates = rankCandidates(resolved?.candidates ?? [], wanted);
  if (candidates.length === 0) {
    throw new Error(
      `no installed application matches "${name}" — try the exact program name, ` +
        "or ask the user how they launch it"
    );
  }

  const launch = (chosen: AppCandidate): Promise<unknown> =>
    host.request("launch", {
      path: chosen.path,
      kind: chosen.kind,
      ...(args.length > 0 ? { args } : {}),
    });

  // Explicit user choice (relayed back as a path we previously offered): must
  // be one of the freshly resolved candidates, never an invented path.
  if (appPath) {
    const picked = candidates.find(
      (c) => c.path.toLowerCase() === appPath.toLowerCase()
    );
    if (!picked) {
      return {
        candidates: candidates.slice(0, 6).map(publicCandidate),
        note:
          "that app_path is not among the current candidates — pick one of these " +
          "exact paths for app_path and call open_app again",
      };
    }
    return launch(picked);
  }

  if (candidates.length === 1) {
    return launch(candidates[0]);
  }

  // Launch the top candidate unless the tie at the top is between GENUINELY
  // DIFFERENT apps (distinct folded names). Same-app near-duplicates —
  // notepad.exe vs a WindowsApps Notepad, an .exe vs its UWP twin — should
  // just launch the best-ranked; only a real "did you mean A or B?" is
  // relayed. This is what keeps open_app from looping without ever launching.
  const top = candidates[0];
  const topScore = scoreCandidate(top, wanted);
  const tiedTop = candidates.filter((c) => scoreCandidate(c, wanted) === topScore);
  const distinctNames = new Set(tiedTop.map((c) => foldName(c.name)));
  if (distinctNames.size <= 1) {
    const result = await launch(top);
    return typeof result === "object" && result
      ? { ...(result as Record<string, unknown>), chosen: `${top.name} (${top.path})` }
      : result;
  }

  // Genuine tie between different apps — relay for the user to pick.
  return {
    candidates: tiedTop.slice(0, 6).map(publicCandidate),
    note:
      "several different applications match equally — ask the user which one, then " +
      "call open_app again with app_path set to that candidate's exact path",
  };
}

function publicCandidate(c: AppCandidate): AppCandidate {
  return { name: c.name, path: c.path, kind: c.kind };
}

/**
 * Score a resolved candidate against the wanted name. Higher is better:
 * a real executable, an exact/prefix name match, and a 64-bit System32 path
 * are preferred; x86 (SysWOW64), ISE variants, and UWP entries are
 * de-prioritized so common apps (explorer, powershell, vs code) resolve to
 * the obvious target without asking.
 */
function scoreCandidate(c: AppCandidate, wanted: string): number {
  let score = 0;
  if (c.kind === "exe") score += 3;
  const folded = foldName(c.name);
  if (folded === wanted) score += 3;
  else if (folded.startsWith(wanted)) score += 2;
  else if (folded.includes(wanted)) score += 1;
  const p = c.path.toLowerCase();
  if (p.includes("\\system32\\")) score += 1;
  if (p.includes("\\syswow64\\")) score -= 1;
  if ((p.includes("_ise") || folded.includes("ise")) && !wanted.includes("ise")) {
    score -= 3;
  }
  return score;
}

function rankCandidates(candidates: AppCandidate[], wanted: string): AppCandidate[] {
  return [...candidates].sort((a, b) => {
    const diff = scoreCandidate(b, wanted) - scoreCandidate(a, wanted);
    return diff !== 0 ? diff : a.path.length - b.path.length;
  });
}

function foldName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    // Fold away a launcher extension so "notepad.exe" matches "notepad".
    .replace(/\.(exe|lnk)$/, "");
}

/**
 * Does a title target plausibly name the window Voxara just launched? Used so
 * "type into powershell" reuses the exact terminal Voxara opened rather than a
 * title match on some other PowerShell (e.g. the dev terminal).
 */
function matchesLaunched(
  target: string,
  launched: { title: string; process: string }
): boolean {
  const t = foldName(target);
  if (!t) {
    return true; // no title given ⇒ default to the launched window
  }
  const title = foldName(launched.title);
  const process = foldName(launched.process);
  return (
    (!!title && (title.includes(t) || t.includes(title))) ||
    (!!process && (process.includes(t) || t.includes(process)))
  );
}

function isAmbiguous(value: unknown): value is AmbiguousWindows {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as AmbiguousWindows).ambiguous)
  );
}

/**
 * Bound the outline to the configured character budget
 * (CONTROL_MAX_SNAPSHOT_CHARS), exactly like the browser snapshot (§9.1).
 */
export function boundOutline(outline: DesktopOutline, maxChars: number): DesktopOutline {
  const header = { window: outline.window, process: outline.process };
  let used = JSON.stringify(header).length;
  const kept: DesktopElement[] = [];

  const elements = Array.isArray(outline.elements) ? outline.elements : [];
  for (const element of elements) {
    const cost = JSON.stringify(element).length + 1;
    if (used + cost > maxChars) {
      break;
    }
    used += cost;
    kept.push(element);
  }

  const dropped = elements.length - kept.length;
  return {
    window: outline.window,
    ...(outline.process ? { process: outline.process } : {}),
    elements: kept,
    ...(dropped > 0
      ? { truncated: `${dropped} more element(s) beyond the snapshot budget — target a smaller area` }
      : {}),
  };
}

// ── Process-wide singleton over the shared host ──────────────────────

let executorSingleton: DesktopExecutor | undefined;

export function getDesktopExecutor(): DesktopExecutor {
  if (!executorSingleton) {
    executorSingleton = createDesktopExecutor(getDesktopHost());
  }
  return executorSingleton;
}
