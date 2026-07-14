import { createBrowserExecutor, BrowserExecutor, BridgeLike } from "../src/control/executor";
import { resetControlSessionGrants } from "../src/control/policy";
import { PageSnapshot, SnapshotElement } from "../src/control/types";
import { createBrowserActTool } from "../src/providers/tools/browserAct";
import { createBrowserReadTool } from "../src/providers/tools/browserRead";

const element = (ref: string, overrides: Partial<SnapshotElement> = {}): SnapshotElement => ({
  ref,
  role: "link",
  name: `Element ${ref}`,
  ...overrides,
});

function fakeBridge(
  respond: (command: string, params: Record<string, unknown>) => unknown,
  connected = true
): BridgeLike {
  return {
    start: async () => undefined,
    isExtensionConnected: () => connected,
    request: async <T,>(command: string, params: Record<string, unknown> = {}) =>
      respond(command, params) as T,
  };
}

function fakeExecutor(overrides: Partial<BrowserExecutor> = {}): BrowserExecutor {
  return {
    readPage: async () => ({ url: "https://a", title: "A", elements: [] }),
    listTabs: async () => [],
    act: async () => ({ done: true }),
    screenshot: async () => ({ kind: "image", mimeType: "image/png", base64: "aW1n" }),
    execJs: async () => ({ value: "undefined" }),
    lookupRef: () => undefined,
    isAvailable: () => true,
    ...overrides,
  };
}

describe("browser executor", () => {
  test("bounds the snapshot to the character budget, keeping the head", async () => {
    const elements = Array.from({ length: 50 }, (_, i) => element(`e${i + 1}`));
    const executor = createBrowserExecutor(
      fakeBridge(() => ({ url: "https://example.com", title: "Example", elements })),
      () => 800
    );

    const snapshot = await executor.readPage();
    expect(snapshot.elements.length).toBeGreaterThan(0);
    expect(snapshot.elements.length).toBeLessThan(50);
    expect(snapshot.elements[0].ref).toBe("e1");
    expect(snapshot.truncated).toMatch(/more element/);
    expect(JSON.stringify({ ...snapshot, truncated: undefined }).length).toBeLessThanOrEqual(900);
  });

  test("caches snapshot refs for policy lookup, replaced by the next snapshot", async () => {
    let elements = [element("e1", { role: "button", state: { type: "submit" } })];
    const executor = createBrowserExecutor(
      fakeBridge(() => ({ url: "https://a", title: "A", elements })),
      () => 8000
    );

    await executor.readPage();
    expect(executor.lookupRef("e1")?.state?.type).toBe("submit");

    elements = [element("e2")];
    await executor.readPage();
    expect(executor.lookupRef("e1")).toBeUndefined();
    expect(executor.lookupRef("e2")).toBeDefined();
  });

  test("fails fast with pairing guidance when the extension is not connected", async () => {
    const executor = createBrowserExecutor(fakeBridge(() => null, false), () => 8000);
    await expect(executor.readPage()).rejects.toThrow("llmtest control doctor");
  });
});

describe("browser_read tool", () => {
  test("returns the snapshot and journals an observe decision", async () => {
    const journal = jest.fn();
    const snapshot: PageSnapshot = { url: "https://a", title: "A", elements: [element("e1")] };
    const tool = createBrowserReadTool({
      executor: () => fakeExecutor({ readPage: async () => snapshot }),
      journal,
    });

    await expect(
      tool.execute({ what: "page" }, ".", { sessionId: "s1" })
    ).resolves.toEqual(snapshot);
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s1",
      intent: "browser_read:page",
      policyDecision: "allowed",
      outcome: "success",
    }));
  });

  test("journals and rethrows executor failures", async () => {
    const journal = jest.fn();
    const tool = createBrowserReadTool({
      executor: () => fakeExecutor({
        listTabs: async () => {
          throw new Error("l'extension Chrome n'est pas connectée");
        },
      }),
      journal,
    });

    await expect(tool.execute({ what: "tabs" }, ".")).rejects.toThrow("pas connectée");
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "error",
      intent: "browser_read:tabs",
    }));
  });
});

describe("browser_act tool", () => {
  beforeEach(() => resetControlSessionGrants());

  test("under session_grant, trusted runtime approval executes the blocked action", async () => {
    const journal = jest.fn();
    const act = jest.fn(async () => ({ tabId: 3 }));
    const tool = createBrowserActTool({
      executor: () => fakeExecutor({ act }),
      journal,
      trustLevel: () => "session_grant",
    });

    const blocked = await tool.execute(
      { action: "navigate", url: "https://youtube.com" },
      ".",
      { sessionId: "grant-flow" }
    );
    expect(String(blocked)).toMatch(/^action_blocked \(needs_grant\)/);
    expect(act).not.toHaveBeenCalled();
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({
      policyDecision: "needs_grant",
      outcome: "blocked",
    }));

    const confirmed = await tool.execute(
      { action: "navigate", url: "https://youtube.com" },
      ".",
      { sessionId: "grant-flow", controlApproved: true }
    );
    expect(confirmed).toEqual({ tabId: 3 });

    // The grant persists: the next reversible action flows without asking.
    const next = await tool.execute(
      { action: "open_tab", url: "https://example.com" },
      ".",
      { sessionId: "grant-flow" }
    );
    expect(next).toEqual({ tabId: 3 });
    expect(act).toHaveBeenCalledTimes(2);
  });

  test("a submit-classified click needs its own confirmation even with the session grant", async () => {
    const tool = createBrowserActTool({
      executor: () => fakeExecutor({
        lookupRef: (ref) =>
          ref === "e7" ? element("e7", { role: "button", state: { type: "submit", inForm: true } }) : undefined,
      }),
      journal: jest.fn(),
      trustLevel: () => "session_grant",
    });

    // Establish the session grant first.
    await tool.execute(
      { action: "navigate", url: "https://a" },
      ".",
      { sessionId: "s2", controlApproved: true }
    );

    const blocked = await tool.execute({ action: "click", ref: "e7" }, ".", { sessionId: "s2" });
    expect(String(blocked)).toMatch(/^action_blocked \(needs_confirmation\)/);
  });

  test("close_tab is sensitive and reports its concrete target", async () => {
    const tool = createBrowserActTool({
      executor: () => fakeExecutor(),
      journal: jest.fn(),
      trustLevel: () => "session_grant",
    });

    const blocked = await tool.execute({ action: "close_tab", tab_id: 12 }, ".", { sessionId: "s3" });
    expect(String(blocked)).toContain("needs_confirmation");
    expect(String(blocked)).toContain("tab:12");
  });

  test("validates intent parameters before touching the policy or the bridge", async () => {
    const tool = createBrowserActTool({
      executor: () => fakeExecutor(),
      journal: jest.fn(),
      trustLevel: () => "auto",
    });

    await expect(tool.execute({ action: "click" }, ".")).resolves.toMatch(/requires ref/);
    // Invented refs (XPaths, selectors, bare numbers) are rejected with
    // guidance before reaching the policy or the bridge.
    await expect(tool.execute({ action: "click", ref: "//input[@name='q']" }, "."))
      .resolves.toMatch(/not a valid ref/);
    await expect(tool.execute({ action: "fill", ref: "36", value: "x" }, "."))
      .resolves.toMatch(/not a valid ref/);
    await expect(tool.execute({ action: "navigate" }, ".")).resolves.toMatch(/requires url/);
    await expect(tool.execute({ action: "navigate", url: "file:///etc" }, "."))
      .resolves.toMatch(/http\(s\)/);
    await expect(tool.execute({ action: "fill", ref: "e1" }, ".")).resolves.toMatch(/requires value/);
    await expect(tool.execute({ action: "detonate" }, ".")).resolves.toMatch(/action must be one of/);
  });

  test("under auto, actions run without confirmation and are journaled", async () => {
    const journal = jest.fn();
    const tool = createBrowserActTool({
      executor: () => fakeExecutor({ act: async () => "ok" }),
      journal,
      trustLevel: () => "auto",
    });

    await expect(
      tool.execute({ action: "close_tab" }, ".", { sessionId: "s4" })
    ).resolves.toBe("ok");
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({
      intent: "browser_act:close_tab",
      policyDecision: "allowed",
      outcome: "success",
    }));
  });
});
