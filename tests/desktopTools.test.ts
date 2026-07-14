import {
  createDesktopExecutor,
  DesktopExecutor,
  DesktopHostLike,
} from "../src/control/desktop";
import { resetControlSessionGrants } from "../src/control/policy";
import { DesktopElement } from "../src/control/types";
import { createDesktopActTool } from "../src/providers/tools/desktopAct";
import { createDesktopReadTool } from "../src/providers/tools/desktopRead";

/** A fake desktop host: a settable generation and a scripted responder. */
function fakeHost(
  respond: (command: string, params: Record<string, unknown>) => unknown
): DesktopHostLike & { generation: number } {
  return {
    generation: 1,
    request: async <T,>(command: string, params: Record<string, unknown> = {}) =>
      respond(command, params) as T,
    interrupt: async () => undefined,
  };
}

const el = (overrides: Partial<DesktopElement> = {}): DesktopElement => ({
  ref: "d1",
  controlType: "Button",
  name: "OK",
  ...overrides,
});

function fakeExecutor(overrides: Partial<DesktopExecutor> = {}): DesktopExecutor {
  return {
    listWindows: async () => [],
    readElements: async () => ({ window: "W", elements: [] }),
    act: async () => ({ done: true }),
    lookupRef: () => undefined,
    idleMs: async () => 10000,
    interrupt: async () => undefined,
    ...overrides,
  };
}

describe("desktop executor", () => {
  test("bounds the outline and caches refs, invalidating on host restart", async () => {
    const elements = [el({ ref: "d1" }), el({ ref: "d2", name: "Cancel" })];
    const host = fakeHost((command) =>
      command === "elements" ? { window: "Notepad", elements } : null
    );
    const executor = createDesktopExecutor(host, () => 8000);

    const outline = await executor.readElements("Notepad");
    expect("elements" in outline && outline.elements).toHaveLength(2);
    expect(executor.lookupRef("d1")?.name).toBe("OK");

    // A host restart (generation bump) makes every earlier ref stale.
    host.generation = 2;
    expect(executor.lookupRef("d1")).toBeUndefined();
  });

  test("readElements relays ambiguous window candidates instead of guessing", async () => {
    const host = fakeHost(() => ({ ambiguous: ["Doc1 — Word", "Doc2 — Word"] }));
    const executor = createDesktopExecutor(host, () => 8000);
    const result = await executor.readElements("Word");
    expect("ambiguous" in result && result.ambiguous).toEqual(["Doc1 — Word", "Doc2 — Word"]);
    // An ambiguous read must not populate the ref cache.
    expect(executor.lookupRef("d1")).toBeUndefined();
  });

  test("open_app relays only when different apps tie at the top score", async () => {
    const launched: unknown[] = [];
    const host = fakeHost((command, params) => {
      if (command === "resolve_app") {
        // Two DIFFERENT apps, same score against "editor" ⇒ genuine tie.
        return {
          candidates: [
            { name: "Editor Alpha", path: "C:/alpha.exe", kind: "exe" },
            { name: "Editor Beta", path: "C:/beta.exe", kind: "exe" },
          ],
        };
      }
      if (command === "launch") {
        launched.push(params);
        return { launched: params.path };
      }
      return null;
    });
    const executor = createDesktopExecutor(host, () => 8000);

    const ambiguous = await executor.act({ action: "open_app", target: "editor" });
    expect(ambiguous).toMatchObject({ candidates: expect.any(Array) });
    expect(launched).toHaveLength(0);
  });

  test("open_app launches the clear winner (notepad.exe beats a same-named lookalike)", async () => {
    const launched: Record<string, unknown>[] = [];
    const host = fakeHost((command, params) => {
      if (command === "resolve_app") {
        return {
          candidates: [
            { name: "notepad", path: "C:/Program Files/Git/usr/bin/notepad", kind: "exe" },
            { name: "notepad.exe", path: "C:/windows/system32/notepad.exe", kind: "exe" },
          ],
        };
      }
      if (command === "launch") {
        launched.push(params);
        return { launched: params.path };
      }
      return null;
    });
    const executor = createDesktopExecutor(host, () => 8000);

    const result = await executor.act({ action: "open_app", target: "notepad" });
    // The System32 exe wins on the path bonus; no "which one?" relay.
    expect(launched).toHaveLength(1);
    expect(String(launched[0].path).toLowerCase()).toContain("system32");
    expect(result).toMatchObject({ launched: expect.any(String) });
  });

  test("app_path pins a specific candidate from a tied set", async () => {
    const launched: Record<string, unknown>[] = [];
    const host = fakeHost((command, params) => {
      if (command === "resolve_app") {
        return {
          candidates: [
            { name: "Editor Alpha", path: "C:/alpha.exe", kind: "exe" },
            { name: "Editor Beta", path: "C:/beta.exe", kind: "exe" },
          ],
        };
      }
      if (command === "launch") {
        launched.push(params);
        return { launched: params.path };
      }
      return null;
    });
    const executor = createDesktopExecutor(host, () => 8000);

    await executor.act({ action: "open_app", target: "editor", appPath: "C:/beta.exe" });
    expect(launched).toEqual([{ path: "C:/beta.exe", kind: "exe" }]);

    // An app_path that was never offered is refused with the candidate list.
    const refused = await executor.act({
      action: "open_app",
      target: "editor",
      appPath: "C:/invented.exe",
    });
    expect(refused).toMatchObject({ note: expect.stringContaining("not among") });
  });

  test("open_app launches directly when a single candidate resolves", async () => {
    const launched: unknown[] = [];
    const host = fakeHost((command, params) => {
      if (command === "resolve_app") {
        return { candidates: [{ name: "Terminal", path: "C:/wt.exe", kind: "exe" }] };
      }
      if (command === "launch") {
        launched.push(params);
        return { launched: params.path };
      }
      return null;
    });
    const executor = createDesktopExecutor(host, () => 8000);
    await executor.act({ action: "open_app", target: "terminal", args: ["npm", "test"] });
    expect(launched).toEqual([{ path: "C:/wt.exe", kind: "exe", args: ["npm", "test"] }]);
  });

  test("later terminal actions reuse the exact window ref returned by launch", async () => {
    const typed: Record<string, unknown>[] = [];
    const host = fakeHost((command, params) => {
      if (command === "resolve_app") {
        return {
          candidates: [
            { name: "powershell", path: "C:/Windows/powershell.exe", kind: "exe" },
          ],
        };
      }
      if (command === "launch") {
        // Windows 11: WindowsTerminal owns this handle, not powershell.exe.
        return {
          launched: params.path,
          processId: 12,
          ref: "w98765",
          window: "Windows PowerShell",
          process: "WindowsTerminal",
        };
      }
      if (command === "type_submit") {
        typed.push(params);
        return { submitted: true };
      }
      return null;
    });
    const executor = createDesktopExecutor(host, () => 8000);

    await executor.act({ action: "open_app", target: "powershell" });
    await executor.act({
      action: "type",
      target: "PowerShell",
      text: "Get-Date",
      submit: true,
    });

    expect(typed).toEqual([{ handle: "98765", text: "Get-Date" }]);
  });

  test("keyboard input cannot substitute a different ref for the launched window", async () => {
    const typed = jest.fn();
    const host = fakeHost((command, params) => {
      if (command === "resolve_app") {
        return {
          candidates: [
            { name: "powershell", path: "C:/Windows/powershell.exe", kind: "exe" },
          ],
        };
      }
      if (command === "launch") {
        return {
          launched: params.path,
          ref: "w111",
          window: "Windows PowerShell",
          process: "WindowsTerminal",
        };
      }
      if (command === "type_submit") typed(params);
      return null;
    });
    const executor = createDesktopExecutor(host, () => 8000);
    await executor.act({ action: "open_app", target: "powershell" });

    await expect(
      executor.act({
        action: "type",
        target: "w222",
        text: "echo wrong-window",
        submit: true,
      })
    ).rejects.toThrow(/not the window Voxara just opened/);
    expect(typed).not.toHaveBeenCalled();
  });

  test("a launch without a stable ref fails closed for later keyboard input", async () => {
    const typed = jest.fn();
    const host = fakeHost((command, params) => {
      if (command === "resolve_app") {
        return {
          candidates: [
            { name: "Terminal", path: "Terminal.AppId", kind: "uwp" },
          ],
        };
      }
      if (command === "launch") {
        return { launched: params.path, kind: "uwp", note: "no stable window" };
      }
      if (command === "type_submit") typed(params);
      return null;
    });
    const executor = createDesktopExecutor(host, () => 8000);
    await executor.act({ action: "open_app", target: "terminal" });

    await expect(
      executor.act({
        action: "type",
        target: "w999",
        text: "echo unsafe",
        submit: true,
      })
    ).rejects.toThrow(/no stable window ref/);
    expect(typed).not.toHaveBeenCalled();
  });
});

describe("desktop_read tool", () => {
  test("windows list is an observe decision", async () => {
    const journal = jest.fn();
    const windows = [
      { title: "Notepad", process: "notepad", pid: 1, ref: "w101", focused: true },
    ];
    const tool = createDesktopReadTool({
      executor: () => fakeExecutor({ listWindows: async () => windows }),
      journal,
    });
    await expect(tool.execute({ what: "windows" }, ".", { sessionId: "s" })).resolves.toEqual(windows);
    expect(journal).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "desktop_read:windows", policyDecision: "allowed" })
    );
  });

  test("what=elements requires a target", async () => {
    const tool = createDesktopReadTool({ executor: () => fakeExecutor(), journal: jest.fn() });
    await expect(tool.execute({ what: "elements" }, ".")).resolves.toMatch(/requires target/);
  });
});

describe("desktop_act tool", () => {
  beforeEach(() => resetControlSessionGrants());

  test("a model-supplied confirmed flag cannot bypass the session grant", async () => {
    const act = jest.fn(async () => "opened");
    const tool = createDesktopActTool({
      executor: () => fakeExecutor({ act }),
      journal: jest.fn(),
      trustLevel: () => "session_grant",
    });

    const blocked = await tool.execute(
      { action: "open_app", target: "powershell", confirmed: true },
      ".",
      { sessionId: "untrusted-confirmed" }
    );
    expect(String(blocked)).toMatch(/^action_blocked \(needs_grant\)/);
    expect(act).not.toHaveBeenCalled();
  });

  test("type rejects control characters with guidance to use keys (D9)", async () => {
    const tool = createDesktopActTool({
      executor: () => fakeExecutor(),
      journal: jest.fn(),
      trustLevel: () => "auto",
    });
    await expect(
      tool.execute({ action: "type", target: "Terminal", text: "git status\n" }, ".")
    ).resolves.toMatch(/keys/);
  });

  test("the session grant covers atomic type+submit without a command retry", async () => {
    const act = jest.fn(async () => ({ typed: 8, submitted: true }));
    const tool = createDesktopActTool({
      executor: () => fakeExecutor({ act }),
      journal: jest.fn(),
      trustLevel: () => "session_grant",
    });
    // This is the one "take control" consent from opening/focusing the app.
    await tool.execute(
      { action: "focus", target: "Windows PowerShell" },
      ".",
      { sessionId: "sub1", controlApproved: true }
    );
    act.mockClear();

    // No confirmed:true magic flag and no per-command confirmation.
    const ok = await tool.execute(
      { action: "type", target: "Windows PowerShell", text: "ipconfig", submit: true },
      ".",
      { sessionId: "sub1" }
    );
    expect(ok).toMatchObject({ submitted: true });
    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ submit: true }));
  });

  test("plain type (no submit) stays reversible and free under the grant", async () => {
    const act = jest.fn(async () => ({ typed: 8 }));
    const tool = createDesktopActTool({
      executor: () => fakeExecutor({ act }),
      journal: jest.fn(),
      trustLevel: () => "session_grant",
    });
    await tool.execute(
      { action: "focus", target: "X" },
      ".",
      { sessionId: "sub2", controlApproved: true }
    );
    await expect(
      tool.execute({ action: "type", target: "Editor", text: "hello" }, ".", { sessionId: "sub2" })
    ).resolves.toMatchObject({ typed: 8 });
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ submit: false }));
  });

  test("keys is sensitive and confirmed with the concrete command", async () => {
    const act = jest.fn(async () => "ok");
    const tool = createDesktopActTool({
      executor: () => fakeExecutor({ act }),
      journal: jest.fn(),
      trustLevel: () => "session_grant",
    });
    await tool.execute(
      { action: "focus", target: "Terminal" },
      ".",
      { sessionId: "s1", controlApproved: true }
    );
    act.mockClear();
    const blocked = await tool.execute(
      { action: "keys", target: "Terminal", keys: "enter" },
      ".",
      { sessionId: "s1" }
    );
    expect(String(blocked)).toMatch(/^action_blocked \(needs_confirmation\)/);
    expect(String(blocked)).toContain("enter");
    expect(act).not.toHaveBeenCalled();
  });

  test("the session grant covers open_app command args and existing paths", async () => {
    const journal = jest.fn();
    const tool = createDesktopActTool({
      executor: () => fakeExecutor({ act: async () => "launched" }),
      journal,
      trustLevel: () => "session_grant",
    });
    // Establish the grant.
    await tool.execute(
      { action: "focus", target: "X" },
      ".",
      { sessionId: "s2", controlApproved: true }
    );

    const command = await tool.execute(
      { action: "open_app", target: "terminal", args: ["npm test"] },
      ".",
      { sessionId: "s2" }
    );
    expect(command).toBe("launched");

    // An existing path (this test file) is a document-open — reversible, so it
    // flows under the established grant.
    const existing = __filename;
    const opened = await tool.execute(
      { action: "open_app", target: "editor", args: [existing] },
      ".",
      { sessionId: "s2" }
    );
    expect(opened).toBe("launched");
  });

  test("a stale/unknown ref makes invoke sensitive", async () => {
    const tool = createDesktopActTool({
      executor: () => fakeExecutor({ lookupRef: () => undefined }),
      journal: jest.fn(),
      trustLevel: () => "session_grant",
    });
    await tool.execute(
      { action: "focus", target: "X" },
      ".",
      { sessionId: "s3", controlApproved: true }
    );
    const blocked = await tool.execute({ action: "invoke", ref: "d9" }, ".", { sessionId: "s3" });
    expect(String(blocked)).toMatch(/needs_confirmation/);
  });

  test("invoke on a known ref is reversible and flows under the grant", async () => {
    const act = jest.fn(async () => ({ invoked: "OK" }));
    const tool = createDesktopActTool({
      executor: () => fakeExecutor({ act, lookupRef: (r) => (r === "d1" ? el() : undefined) }),
      journal: jest.fn(),
      trustLevel: () => "session_grant",
    });
    await tool.execute(
      { action: "focus", target: "X" },
      ".",
      { sessionId: "s4", controlApproved: true }
    );
    await expect(
      tool.execute({ action: "invoke", ref: "d1" }, ".", { sessionId: "s4" })
    ).resolves.toEqual({ invoked: "OK" });
    expect(act).toHaveBeenCalled();
  });

  test("rejects invented desktop refs before the policy or host", async () => {
    const tool = createDesktopActTool({
      executor: () => fakeExecutor(),
      journal: jest.fn(),
      trustLevel: () => "auto",
    });
    await expect(
      tool.execute({ action: "invoke", ref: "//button" }, ".")
    ).resolves.toMatch(/not a valid desktop ref/);
  });

  test("refuses fast-lane actions while a pilot runs", async () => {
    const { setActivePilotTask } = await import("../src/control/pilotState");
    setActivePilotTask("task-pilot-1");
    try {
      const tool = createDesktopActTool({
        executor: () => fakeExecutor(),
        journal: jest.fn(),
        trustLevel: () => "auto",
      });
      const blocked = await tool.execute({ action: "focus", target: "X" }, ".");
      expect(String(blocked)).toMatch(/pilot_running/);
    } finally {
      setActivePilotTask(null);
    }
  });
});
