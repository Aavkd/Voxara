import {
  classifyEffect,
  evaluateControlIntent,
  hasControlSessionGrant,
  resetControlSessionGrants,
  revokeControlSession,
} from "../src/control/policy";
import { SnapshotElement } from "../src/control/types";

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
