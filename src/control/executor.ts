/**
 * Control executor — routes typed intents to channels and owns the
 * channel-availability logic (browser intents fail fast with guidance when
 * no extension is connected).
 *
 * Phase C3b (docs/phase-c3-computer-control.md §5, §7): browser channel only.
 * The desktop channel and the code fallback arrive with C3c.
 */

import { loadControlMaxSnapshotChars } from "../config/loader";
import {
  BrowserBridge,
  EXTENSION_NOT_CONNECTED_MESSAGE,
  getBrowserBridge,
} from "./browserBridge";
import {
  BrowserAction,
  BrowserTabInfo,
  PageSnapshot,
  ScreenImageResult,
  SnapshotElement,
} from "./types";

/** Subset of BrowserBridge the executor needs — injectable in tests. */
export interface BridgeLike {
  start(): Promise<void>;
  isExtensionConnected(): boolean;
  request<T = unknown>(
    command: "snapshot" | "act" | "navigate" | "tabs" | "screenshot" | "exec_js",
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T>;
}

export interface BrowserActRequest {
  action: BrowserAction;
  ref?: string;
  value?: string;
  url?: string;
  tabId?: number;
}

export interface BrowserExecutor {
  /** Bounded accessibility-style outline of the active (or given) tab. */
  readPage(tabId?: number): Promise<PageSnapshot>;
  listTabs(): Promise<BrowserTabInfo[]>;
  act(request: BrowserActRequest): Promise<unknown>;
  /** Tab screenshot via the extension — serves screen_view target=browser_tab. */
  screenshot(tabId?: number): Promise<ScreenImageResult>;
  /** Run generated JS in the active tab (control_code browser_js, §9.4). */
  execJs(code: string, tabId?: number): Promise<unknown>;
  /**
   * Element from the LAST snapshot for policy classification (§8.1).
   * Undefined for a ref never seen or invalidated by a newer snapshot.
   */
  lookupRef(ref: string): SnapshotElement | undefined;
  isAvailable(): boolean;
}

export function createBrowserExecutor(
  bridge: BridgeLike,
  maxSnapshotChars: () => number = loadControlMaxSnapshotChars
): BrowserExecutor {
  // Refs are ephemeral: each snapshot replaces the cache, mirroring the
  // content script's own registry lifecycle.
  let lastSnapshotRefs = new Map<string, SnapshotElement>();

  const ensureAvailable = async (): Promise<void> => {
    // Starting is idempotent and cheap; a session that never paired still
    // fails with the doctor guidance below.
    await bridge.start().catch(() => undefined);
    if (!bridge.isExtensionConnected()) {
      throw new Error(EXTENSION_NOT_CONNECTED_MESSAGE);
    }
  };

  return {
    async readPage(tabId?: number): Promise<PageSnapshot> {
      await ensureAvailable();
      const raw = await bridge.request<PageSnapshot>("snapshot", tabId !== undefined ? { tabId } : {});
      const bounded = boundSnapshot(raw, maxSnapshotChars());
      lastSnapshotRefs = new Map(bounded.elements.map((el) => [el.ref, el]));
      return bounded;
    },

    async listTabs(): Promise<BrowserTabInfo[]> {
      await ensureAvailable();
      return bridge.request<BrowserTabInfo[]>("tabs", { op: "list" });
    },

    async act(request: BrowserActRequest): Promise<unknown> {
      await ensureAvailable();
      switch (request.action) {
        case "navigate":
          return bridge.request("navigate", {
            url: request.url,
            ...(request.tabId !== undefined ? { tabId: request.tabId } : {}),
          });
        case "open_tab":
          return bridge.request("tabs", { op: "open", url: request.url });
        case "activate_tab":
          return bridge.request("tabs", { op: "activate", tabId: request.tabId });
        case "close_tab":
          return bridge.request("tabs", {
            op: "close",
            ...(request.tabId !== undefined ? { tabId: request.tabId } : {}),
          });
        case "click":
        case "fill":
        case "select":
        case "scroll_to":
          return bridge.request("act", {
            ref: request.ref,
            action: request.action,
            ...(request.value !== undefined ? { value: request.value } : {}),
            ...(request.tabId !== undefined ? { tabId: request.tabId } : {}),
          });
        default:
          throw new Error(`unknown browser action "${String(request.action)}"`);
      }
    },

    async screenshot(tabId?: number): Promise<ScreenImageResult> {
      await ensureAvailable();
      const base64 = await bridge.request<string>(
        "screenshot",
        tabId !== undefined ? { tabId } : {}
      );
      if (typeof base64 !== "string" || base64.length === 0) {
        throw new Error("the extension returned no screenshot data");
      }
      return { kind: "image", mimeType: "image/png", base64 };
    },

    async execJs(code: string, tabId?: number): Promise<unknown> {
      await ensureAvailable();
      return bridge.request("exec_js", {
        code,
        ...(tabId !== undefined ? { tabId } : {}),
      });
    },

    lookupRef(ref: string): SnapshotElement | undefined {
      return lastSnapshotRefs.get(ref);
    },

    isAvailable(): boolean {
      return bridge.isExtensionConnected();
    },
  };
}

/**
 * Bound the snapshot to the configured character budget
 * (CONTROL_MAX_SNAPSHOT_CHARS, default 8000): elements arrive
 * viewport-visible first from the extension, so truncation drops the least
 * relevant tail and appends a marker (§7.2).
 */
export function boundSnapshot(snapshot: PageSnapshot, maxChars: number): PageSnapshot {
  const header = { url: snapshot.url, title: snapshot.title };
  let used = JSON.stringify(header).length;
  const kept: SnapshotElement[] = [];

  for (const element of snapshot.elements) {
    const cost = JSON.stringify(element).length + 1;
    if (used + cost > maxChars) {
      break;
    }
    used += cost;
    kept.push(element);
  }

  const dropped = snapshot.elements.length - kept.length;
  return {
    ...header,
    elements: kept,
    ...(dropped > 0
      ? { truncated: `${dropped} more element(s) beyond the snapshot budget — scroll or ask for a specific area` }
      : {}),
  };
}

// ── Process-wide singleton over the shared bridge ────────────────────

let executorSingleton: BrowserExecutor | undefined;

export function getBrowserExecutor(): BrowserExecutor {
  if (!executorSingleton) {
    executorSingleton = createBrowserExecutor(getBrowserBridge());
  }
  return executorSingleton;
}
