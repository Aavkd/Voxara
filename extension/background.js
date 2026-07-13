/**
 * Voxara Browser Bridge — MV3 service worker.
 *
 * Maintains one WebSocket OUT to the local Voxara process
 * (ws://127.0.0.1:<port>, default 7863) and serves its commands against the
 * user's real tabs: snapshot / act / navigate / tabs / screenshot
 * (docs/phase-c3-computer-control.md §7.1–§7.2).
 *
 * Pairing: the token shown by `llmtest control doctor` is pasted once into
 * the options page; the first frame of every connection is a hello carrying
 * it. The server closes mismatching connections.
 */

const DEFAULT_PORT = 7863;
const MAX_SNAPSHOT_ELEMENTS = 200;
const MAX_TABS_LISTED = 50;

let ws = null;
let reconnectDelayMs = 1000;
let reconnectTimer = null;

// ── Connection lifecycle ─────────────────────────────────────────────

async function getSettings() {
  const stored = await chrome.storage.local.get({ token: "", port: DEFAULT_PORT });
  const port = Number.parseInt(stored.port, 10);
  return {
    token: String(stored.token || "").trim(),
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
  };
}

function setStatus(text) {
  chrome.storage.local.set({ bridgeStatus: text, bridgeStatusAt: Date.now() });
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const { token, port } = await getSettings();
  if (!token) {
    setStatus("no pairing token — open the extension options and paste the token from `llmtest control doctor`");
    scheduleReconnect(15000);
    return;
  }

  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (err) {
    setStatus(`connection failed: ${err && err.message ? err.message : err}`);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelayMs = 1000;
    ws.send(JSON.stringify({
      type: "hello",
      token,
      extensionVersion: chrome.runtime.getManifest().version,
    }));
    setStatus(`connected to 127.0.0.1:${port}`);
  };

  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "ping") {
      // App-level keepalive: replying also keeps this service worker alive.
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (message.id && message.command) {
      handleRequest(message);
    }
  };

  ws.onclose = (event) => {
    ws = null;
    if (event.code === 4003) {
      setStatus("pairing token rejected — re-check the token in the extension options");
      scheduleReconnect(30000);
      return;
    }
    setStatus("disconnected — Voxara is not running or the port is wrong");
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose follows and schedules the reconnect.
  };
}

function scheduleReconnect(delayMs) {
  const delay = delayMs !== undefined ? delayMs : reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.port)) {
    try {
      if (ws) ws.close();
    } catch {
      // already closed
    }
    ws = null;
    reconnectDelayMs = 1000;
    connect();
  }
});
// Alarms survive service-worker suspension; setTimeout alone does not.
chrome.alarms.create("voxara-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "voxara-reconnect") {
    connect();
  }
});
connect();

// ── Command dispatch ─────────────────────────────────────────────────

async function handleRequest(message) {
  const { id, command, params = {} } = message;
  let response;
  try {
    const result = await executeCommand(command, params);
    response = { id, ok: true, result };
  } catch (err) {
    response = { id, ok: false, error: err && err.message ? err.message : String(err) };
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

async function executeCommand(command, params) {
  switch (command) {
    case "snapshot":
      return snapshotCommand(params);
    case "act":
      return actCommand(params);
    case "navigate":
      return navigateCommand(params);
    case "tabs":
      return tabsCommand(params);
    case "screenshot":
      return screenshotCommand(params);
    default:
      throw new Error(`unknown command "${command}"`);
  }
}

async function resolveTab(tabId) {
  if (typeof tabId === "number") {
    return chrome.tabs.get(tabId);
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) {
    throw new Error("no active tab");
  }
  return tab;
}

async function runInPage(tabId, func, args) {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  } catch (err) {
    throw new Error(
      `cannot access this page (restricted URL such as chrome:// or the Web Store): ${
        err && err.message ? err.message : err
      }`
    );
  }
  const outcome = results && results[0] ? results[0].result : undefined;
  if (!outcome || outcome.ok !== true) {
    throw new Error(outcome && outcome.error ? outcome.error : "the page script returned no result");
  }
  return outcome.result;
}

async function snapshotCommand(params) {
  const tab = await resolveTab(params.tabId);
  return runInPage(tab.id, buildSnapshotInPage, [MAX_SNAPSHOT_ELEMENTS]);
}

async function actCommand(params) {
  const tab = await resolveTab(params.tabId);
  return runInPage(tab.id, actInPage, [
    String(params.ref || ""),
    String(params.action || ""),
    params.value === undefined ? null : String(params.value),
  ]);
}

async function navigateCommand(params) {
  const url = String(params.url || "");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("navigate only accepts http(s) URLs");
  }
  const tab = await resolveTab(params.tabId);
  await chrome.tabs.update(tab.id, { url });
  return { tabId: tab.id, url };
}

async function tabsCommand(params) {
  const op = String(params.op || "");
  if (op === "list") {
    const tabs = await chrome.tabs.query({});
    return tabs.slice(0, MAX_TABS_LISTED).map((tab) => ({
      id: tab.id,
      title: (tab.title || "").slice(0, 120),
      url: (tab.url || "").slice(0, 300),
      active: Boolean(tab.active),
      windowId: tab.windowId,
    }));
  }
  if (op === "open") {
    const url = String(params.url || "");
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("open only accepts http(s) URLs");
    }
    const tab = await chrome.tabs.create({ url });
    return { tabId: tab.id, url };
  }
  if (op === "activate") {
    const tab = await chrome.tabs.get(Number(params.tabId));
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { tabId: tab.id, title: tab.title };
  }
  if (op === "close") {
    const tab = await resolveTab(params.tabId);
    const closed = { tabId: tab.id, title: tab.title, url: tab.url };
    await chrome.tabs.remove(tab.id);
    return closed;
  }
  throw new Error(`unknown tabs op "${op}"`);
}

async function screenshotCommand(params) {
  const tab = await resolveTab(params.tabId);
  // captureVisibleTab shoots the ACTIVE tab of a window, so a background
  // target must be brought forward first.
  if (typeof params.tabId === "number" && !tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const base64 = String(dataUrl || "").split(",")[1];
  if (!base64) {
    throw new Error("captureVisibleTab returned no image data");
  }
  return base64;
}

// ── Injected page functions ──────────────────────────────────────────
// Self-contained; they run in this extension's isolated world, which
// persists per document — so the ref registry survives between calls and
// dies naturally on navigation.

function buildSnapshotInPage(maxElements) {
  try {
    const registry = new Map();
    window.__voxaraRefs = registry;
    const selectors =
      'a[href], button, input, select, textarea, summary, ' +
      '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
      '[role="checkbox"], [role="radio"], [role="combobox"], [role="option"], ' +
      '[role="textbox"], [role="searchbox"], [onclick], [contenteditable="true"]';

    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const entries = [];
    for (const el of document.querySelectorAll(selectors)) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const inViewport =
        rect.bottom > 0 && rect.top < viewportH && rect.right > 0 && rect.left < viewportW;
      entries.push({ el, top: rect.top, inViewport });
    }
    // Viewport-visible elements first (§7.2), each group in reading order.
    entries.sort((a, b) =>
      a.inViewport === b.inViewport ? a.top - b.top : a.inViewport ? -1 : 1
    );

    const roleFor = (el) => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el.type || "text").toLowerCase();
        if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        return "textbox";
      }
      return "generic";
    };
    const nameFor = (el) => {
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim().slice(0, 80);
      if (el.labels && el.labels.length > 0 && el.labels[0].innerText.trim()) {
        return el.labels[0].innerText.trim().replace(/\s+/g, " ").slice(0, 80);
      }
      const text = (el.innerText || el.value || el.placeholder || el.title || el.alt || "").trim();
      if (text) return text.replace(/\s+/g, " ").slice(0, 80);
      // Image-only links/buttons (YouTube thumbnails, icon buttons) have no
      // text: fall back to descendants' labels, then a readable href tail —
      // an empty name gives the model nothing to reason about.
      const labelled = el.querySelector("[aria-label]");
      const labelledText = labelled && labelled.getAttribute("aria-label");
      if (labelledText && labelledText.trim()) return labelledText.trim().slice(0, 80);
      const img = el.querySelector("img[alt]");
      if (img && img.alt.trim()) return img.alt.trim().slice(0, 80);
      const svgTitle = el.querySelector("svg title");
      if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent.trim().slice(0, 80);
      if (el.href) {
        try {
          const url = new URL(el.href);
          const tail = decodeURIComponent(
            (url.pathname.split("/").filter(Boolean).pop() || url.hostname)
          ).replace(/[-_+]/g, " ").trim();
          if (tail) return tail.slice(0, 80);
        } catch {
          // unparseable href — leave the name empty
        }
      }
      return "";
    };

    const elements = [];
    let counter = 0;
    for (const { el } of entries) {
      if (elements.length >= maxElements) break;
      counter += 1;
      const ref = "e" + counter;
      registry.set(ref, el);
      const tag = el.tagName.toLowerCase();
      const state = {};
      if ((tag === "button" || tag === "input") && typeof el.type === "string" && el.type) {
        state.type = el.type.toLowerCase();
      }
      if (el.closest && el.closest("form")) state.inForm = true;
      if (el.disabled) state.disabled = true;
      if (typeof el.checked === "boolean" && el.checked) state.checked = true;
      if (tag === "a" && el.href) state.href = String(el.href).slice(0, 200);
      const entry = { ref, role: roleFor(el), name: nameFor(el) };
      if (typeof el.value === "string" && el.value && el.type !== "password") {
        entry.value = el.value.slice(0, 80);
      }
      if (Object.keys(state).length > 0) entry.state = state;
      elements.push(entry);
    }
    return {
      ok: true,
      result: { url: location.href, title: document.title, elements },
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function actInPage(ref, action, value) {
  try {
    const registry = window.__voxaraRefs;
    const el = registry && registry.get(ref);
    if (!el || !el.isConnected) {
      return { ok: false, error: `stale ref "${ref}": take a new browser_read snapshot first` };
    }

    const fireInputEvents = (target) => {
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const postState = () => {
      const state = {
        name: (el.getAttribute("aria-label") || el.innerText || el.value || "")
          .trim().replace(/\s+/g, " ").slice(0, 80),
      };
      if (typeof el.value === "string" && el.type !== "password") state.value = el.value.slice(0, 80);
      if (typeof el.checked === "boolean") state.checked = el.checked;
      return state;
    };

    el.scrollIntoView({ block: "center", inline: "nearest" });

    if (action === "scroll_to") {
      return { ok: true, result: postState() };
    }
    if (action === "click") {
      el.click();
      return { ok: true, result: postState() };
    }
    if (action === "fill") {
      if (el.isContentEditable) {
        el.focus();
        el.textContent = value === null ? "" : value;
        fireInputEvents(el);
        return { ok: true, result: postState() };
      }
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (!descriptor || !descriptor.set) {
        return { ok: false, error: "this element cannot be filled" };
      }
      el.focus();
      // Native setter so framework-controlled inputs (React/Vue) see the change.
      descriptor.set.call(el, value === null ? "" : value);
      fireInputEvents(el);
      return { ok: true, result: postState() };
    }
    if (action === "select") {
      if (!(el instanceof HTMLSelectElement)) {
        return { ok: false, error: "select only works on <select> elements" };
      }
      const wanted = value === null ? "" : value.trim();
      const options = Array.from(el.options);
      const match =
        options.find((o) => o.value === wanted) ||
        options.find((o) => o.text.trim() === wanted) ||
        options.find((o) => o.text.trim().toLowerCase().includes(wanted.toLowerCase()));
      if (!match) {
        return {
          ok: false,
          error: `no option matches "${wanted}"; available: ${options
            .slice(0, 20).map((o) => o.text.trim()).join(" | ")}`,
        };
      }
      el.value = match.value;
      fireInputEvents(el);
      return { ok: true, result: postState() };
    }
    return { ok: false, error: `unknown act action "${action}"` };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}
