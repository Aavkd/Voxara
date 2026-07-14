import {
  classifyEffect,
  evaluateControlIntent,
  hasControlSessionGrant,
  resetControlSessionGrants,
  revokeControlSession,
} from "../src/control/policy";
import { DesktopElement, SnapshotElement } from "../src/control/types";

const desktopElement = (overrides: Partial<DesktopElement> = {}): DesktopElement => ({
  ref: "d1",
  controlType: "Button",
  name: "OK",
  ...overrides,
});

const element = (overrides: Partial<SnapshotElement> = {}): SnapshotElement => ({
  ref: "e1",
  role: "button",
  name: "Ajouter au panier",
  ...overrides,
});

describe("effect classification (§8.1)", () => {
  test("observation intents are observe", () => {
    expect(classifyEffect({ tool: "screen_view" })).toBe("observe");
    expect(classifyEffect({ tool: "browser_read" })).toBe("observe");
  });

  test("fill, select, scroll, navigate, and tab openings are reversible", () => {
    for (const action of ["fill", "select", "scroll_to", "navigate", "open_tab", "activate_tab"] as const) {
      expect(classifyEffect({ tool: "browser_act", action })).toBe("act_reversible");
    }
  });

  test("a plain button click is reversible", () => {
    expect(
      classifyEffect({
        tool: "browser_act",
        action: "click",
        element: element({ state: { type: "button", inForm: true } }),
      })
    ).toBe("act_reversible");
  });

  test("a submit-type click is a submission, hence sensitive", () => {
    expect(
      classifyEffect({
        tool: "browser_act",
        action: "click",
        element: element({ state: { type: "submit" } }),
      })
    ).toBe("act_sensitive");
  });

  test("a form-embedded button without an explicit type is sensitive", () => {
    expect(
      classifyEffect({
        tool: "browser_act",
        action: "click",
        element: element({ state: { inForm: true } }),
      })
    ).toBe("act_sensitive");
  });

  test("an unknown ref (no snapshot element) escalates to sensitive", () => {
    expect(classifyEffect({ tool: "browser_act", action: "click" })).toBe("act_sensitive");
  });

  test("close_tab is sensitive", () => {
    expect(classifyEffect({ tool: "browser_act", action: "close_tab" })).toBe("act_sensitive");
  });
});

describe("desktop effect classification (§9.2, D9/D10)", () => {
  test("desktop_read observes", () => {
    expect(classifyEffect({ tool: "desktop_read" })).toBe("observe");
  });

  test("open_app with no args opens reversibly", () => {
    expect(
      classifyEffect({ tool: "desktop_act", action: "open_app", hasArgs: false })
    ).toBe("act_reversible");
  });

  test("open_app whose args are existing paths opens a document (reversible)", () => {
    expect(
      classifyEffect({
        tool: "desktop_act",
        action: "open_app",
        hasArgs: true,
        argsAreExistingPaths: true,
      })
    ).toBe("act_reversible");
  });

  test("open_app with non-path args is command execution (sensitive, D10)", () => {
    expect(
      classifyEffect({
        tool: "desktop_act",
        action: "open_app",
        hasArgs: true,
        argsAreExistingPaths: false,
      })
    ).toBe("act_sensitive");
  });

  test("focus and type are reversible", () => {
    expect(classifyEffect({ tool: "desktop_act", action: "focus" })).toBe("act_reversible");
    expect(classifyEffect({ tool: "desktop_act", action: "type" })).toBe("act_reversible");
  });

  test("keys and close are sensitive (D10)", () => {
    expect(classifyEffect({ tool: "desktop_act", action: "keys" })).toBe("act_sensitive");
    expect(classifyEffect({ tool: "desktop_act", action: "close" })).toBe("act_sensitive");
  });

  test("invoke/set_value are reversible with a known ref, sensitive when stale", () => {
    expect(
      classifyEffect({ tool: "desktop_act", action: "invoke", element: desktopElement() })
    ).toBe("act_reversible");
    expect(classifyEffect({ tool: "desktop_act", action: "invoke" })).toBe("act_sensitive");
    expect(
      classifyEffect({ tool: "desktop_act", action: "set_value", element: desktopElement() })
    ).toBe("act_reversible");
    expect(classifyEffect({ tool: "desktop_act", action: "set_value" })).toBe("act_sensitive");
  });

  test("control_code is always sensitive", () => {
    expect(classifyEffect({ tool: "control_code" })).toBe("act_sensitive");
  });
});

describe("control_code trust decisions (§8.2)", () => {
  beforeEach(() => resetControlSessionGrants());

  test("auto still confirms control_code unless CONTROL_CODE_AUTO is set", () => {
    const blocked = evaluateControlIntent({
      intent: { tool: "control_code" },
      trustLevel: "auto",
      sessionId: "s",
      confirmed: false,
    });
    expect(blocked.outcome).toBe("needs_confirmation");

    const allowed = evaluateControlIntent({
      intent: { tool: "control_code" },
      trustLevel: "auto",
      sessionId: "s",
      confirmed: false,
      controlCodeAuto: true,
    });
    expect(allowed.outcome).toBe("allowed");
  });

  test("a command can be the first acting intent and establishes the one session grant", () => {
    const runCmd = {
      tool: "desktop_act" as const,
      action: "type" as const,
      submits: true,
    };
    // The first command asks for the broad session grant, not a separate
    // per-command confirmation.
    expect(
      evaluateControlIntent({
        intent: runCmd,
        trustLevel: "session_grant",
        sessionId: "cmd1",
        confirmed: false,
      }).outcome
    ).toBe("needs_grant");

    // Confirming that session grant authorizes this command.
    expect(
      evaluateControlIntent({
        intent: runCmd,
        trustLevel: "session_grant",
        sessionId: "cmd1",
        confirmed: true,
      }).outcome
    ).toBe("allowed");
    expect(hasControlSessionGrant("cmd1")).toBe(true);

    // A different later command flows without a magic confirmed flag.
    expect(
      evaluateControlIntent({
        intent: {
          tool: "desktop_act",
          action: "open_app",
          hasArgs: true,
          argsAreExistingPaths: false,
        },
        trustLevel: "session_grant",
        sessionId: "cmd1",
        confirmed: false,
      }).outcome
    ).toBe("allowed");
  });

  test("an existing session grant covers submitted commands without another gate", () => {
    evaluateControlIntent({
      intent: { tool: "desktop_act", action: "focus" },
      trustLevel: "session_grant",
      sessionId: "cmd2",
      confirmed: true,
    });

    expect(
      evaluateControlIntent({
        intent: { tool: "desktop_act", action: "type", submits: true },
        trustLevel: "session_grant",
        sessionId: "cmd2",
        confirmed: false,
      }).outcome
    ).toBe("allowed");
  });

  test("close is NOT covered by the session grant — confirmed each time", () => {
    evaluateControlIntent({
      intent: { tool: "desktop_act", action: "focus" },
      trustLevel: "session_grant",
      sessionId: "cmd-close",
      confirmed: true,
    });
    // Close still needs its own confirmation (data-loss risk).
    expect(
      evaluateControlIntent({
        intent: { tool: "desktop_act", action: "close" },
        trustLevel: "session_grant",
        sessionId: "cmd-close",
        confirmed: false,
      }).outcome
    ).toBe("needs_confirmation");
  });

  test("control_code is NOT covered by the session grant", () => {
    evaluateControlIntent({
      intent: { tool: "desktop_act", action: "focus" },
      trustLevel: "session_grant",
      sessionId: "cmd3",
      confirmed: true,
    });
    expect(
      evaluateControlIntent({
        intent: { tool: "control_code" },
        trustLevel: "session_grant",
        sessionId: "cmd3",
        confirmed: false,
      }).outcome
    ).toBe("needs_confirmation");
  });

  test("a stale desktop ref escalates invoke to a confirmation under session_grant", () => {
    // Establish the session grant with a reversible action.
    evaluateControlIntent({
      intent: { tool: "desktop_act", action: "focus" },
      trustLevel: "session_grant",
      sessionId: "sd",
      confirmed: true,
    });
    const blocked = evaluateControlIntent({
      intent: { tool: "desktop_act", action: "invoke" }, // no element ⇒ stale
      trustLevel: "session_grant",
      sessionId: "sd",
      confirmed: false,
    });
    expect(blocked.outcome).toBe("needs_confirmation");
  });
});

describe("trust-level decisions (§8.2)", () => {
  beforeEach(() => resetControlSessionGrants());

  const reversible = {
    tool: "browser_act" as const,
    action: "navigate" as const,
  };
  const sensitive = {
    tool: "browser_act" as const,
    action: "close_tab" as const,
  };

  test("observe is free under every trust level", () => {
    for (const trustLevel of ["confirm_each", "session_grant", "auto"] as const) {
      const decision = evaluateControlIntent({
        intent: { tool: "browser_read" },
        trustLevel,
        sessionId: "s",
        confirmed: false,
      });
      expect(decision.outcome).toBe("allowed");
    }
  });

  test("session_grant: first reversible action needs the grant, then flows", () => {
    const first = evaluateControlIntent({
      intent: reversible,
      trustLevel: "session_grant",
      sessionId: "s1",
      confirmed: false,
    });
    expect(first.outcome).toBe("needs_grant");
    expect(hasControlSessionGrant("s1")).toBe(false);

    const confirmedRetry = evaluateControlIntent({
      intent: reversible,
      trustLevel: "session_grant",
      sessionId: "s1",
      confirmed: true,
    });
    expect(confirmedRetry.outcome).toBe("allowed");
    expect(hasControlSessionGrant("s1")).toBe(true);

    const subsequent = evaluateControlIntent({
      intent: reversible,
      trustLevel: "session_grant",
      sessionId: "s1",
      confirmed: false,
    });
    expect(subsequent.outcome).toBe("allowed");
  });

  test("the grant is per session and revocable", () => {
    evaluateControlIntent({
      intent: reversible,
      trustLevel: "session_grant",
      sessionId: "s1",
      confirmed: true,
    });
    expect(
      evaluateControlIntent({
        intent: reversible,
        trustLevel: "session_grant",
        sessionId: "OTHER",
        confirmed: false,
      }).outcome
    ).toBe("needs_grant");

    revokeControlSession("s1");
    expect(
      evaluateControlIntent({
        intent: reversible,
        trustLevel: "session_grant",
        sessionId: "s1",
        confirmed: false,
      }).outcome
    ).toBe("needs_grant");
  });

  test("session_grant: sensitive intents are confirmed each time", () => {
    evaluateControlIntent({
      intent: reversible,
      trustLevel: "session_grant",
      sessionId: "s1",
      confirmed: true,
    });

    const blocked = evaluateControlIntent({
      intent: sensitive,
      trustLevel: "session_grant",
      sessionId: "s1",
      confirmed: false,
    });
    expect(blocked.outcome).toBe("needs_confirmation");

    const confirmed = evaluateControlIntent({
      intent: sensitive,
      trustLevel: "session_grant",
      sessionId: "s1",
      confirmed: true,
    });
    expect(confirmed.outcome).toBe("allowed");

    // The sensitive confirmation is per call, never persisted.
    expect(
      evaluateControlIntent({
        intent: sensitive,
        trustLevel: "session_grant",
        sessionId: "s1",
        confirmed: false,
      }).outcome
    ).toBe("needs_confirmation");
  });

  test("confirm_each requires confirmation for every acting intent", () => {
    const blocked = evaluateControlIntent({
      intent: reversible,
      trustLevel: "confirm_each",
      sessionId: "s1",
      confirmed: false,
    });
    expect(blocked.outcome).toBe("needs_confirmation");

    evaluateControlIntent({
      intent: reversible,
      trustLevel: "confirm_each",
      sessionId: "s1",
      confirmed: true,
    });
    // No grant accumulates under confirm_each.
    expect(
      evaluateControlIntent({
        intent: reversible,
        trustLevel: "confirm_each",
        sessionId: "s1",
        confirmed: false,
      }).outcome
    ).toBe("needs_confirmation");
  });

  test("auto allows acting intents without confirmation", () => {
    expect(
      evaluateControlIntent({
        intent: sensitive,
        trustLevel: "auto",
        sessionId: "s1",
        confirmed: false,
      }).outcome
    ).toBe("allowed");
  });
});
