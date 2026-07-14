import { runAgentLoop, stripToolCallArtifacts } from "../src/engine/agentLoop";
import {
  hasPendingFastLaneApproval,
  isExplicitAffirmative,
  resetFastLaneApprovals,
} from "../src/control/fastLaneApproval";
import { ILLMProvider } from "../src/providers/ILLMProvider";
import { IToolProvider } from "../src/providers/tools/IToolProvider";
import { AgentStepResult, Message, messageText } from "../src/types";

function fakeTool(name: string, execute: IToolProvider["execute"]): IToolProvider {
  return { name, description: "test", parameters: { type: "object" }, execute };
}

function fakeProvider(
  steps: Array<AgentStepResult | ((messages: Message[]) => AgentStepResult)>
): { provider: ILLMProvider; observed: Message[][] } {
  const observed: Message[][] = [];
  let call = 0;
  const provider = {
    name: "fake",
    promptWithTools: async (messages: Message[]) => {
      observed.push([...messages]);
      const step = steps[Math.min(call, steps.length - 1)];
      call += 1;
      return typeof step === "function" ? step(messages) : step;
    },
  } as unknown as ILLMProvider;
  return { provider, observed };
}

const tokens = { inputTokens: 1, outputTokens: 1 };

describe("fast-lane approval handoff", () => {
  beforeEach(() => resetFastLaneApprovals());

  test("one spoken yes replays the exact blocked call with trusted approval", async () => {
    const calls: Array<{
      params: Record<string, unknown>;
      approved: boolean;
    }> = [];
    const desktop = fakeTool("desktop_act", async (params, _dir, context) => {
      calls.push({ params: { ...params }, approved: context?.controlApproved === true });
      return context?.controlApproved
        ? { launched: "powershell.exe", ref: "w42" }
        : "action_blocked (needs_grant) — je prends la main ?";
    });
    const first = fakeProvider([
      {
        type: "tool_call",
        toolName: "desktop_act",
        toolParams: { action: "open_app", target: "powershell" },
        ...tokens,
      },
      { type: "final_answer", text: "Je prends la main ?", ...tokens },
    ]);

    await runAgentLoop(
      first.provider,
      [desktop],
      "Lance PowerShell",
      ".",
      3,
      () => undefined,
      undefined,
      undefined,
      { sessionId: "voice-approval" }
    );
    expect(hasPendingFastLaneApproval("voice-approval")).toBe(true);

    const second = fakeProvider([
      (messages) => {
        expect(messageText(messages.at(-1)!)).toContain("powershell.exe");
        return { type: "final_answer", text: "PowerShell est ouvert.", ...tokens };
      },
    ]);
    const resumed = await runAgentLoop(
      second.provider,
      [desktop],
      "Oui, tu peux.",
      ".",
      3,
      () => undefined,
      undefined,
      undefined,
      { sessionId: "voice-approval" }
    );

    expect(resumed.finalAnswer).toBe("PowerShell est ouvert.");
    expect(calls).toEqual([
      {
        params: { action: "open_app", target: "powershell" },
        approved: false,
      },
      {
        params: { action: "open_app", target: "powershell" },
        approved: true,
      },
    ]);
    expect(resumed.toolCallsMade[0].params).toEqual({
      action: "open_app",
      target: "powershell",
    });
    expect(hasPendingFastLaneApproval("voice-approval")).toBe(false);
  });

  test("an unrelated next reply cancels stale approval instead of executing it", async () => {
    const executed = jest.fn(async () => "action_blocked (needs_grant) — ok ?");
    const desktop = fakeTool("desktop_act", executed);
    const first = fakeProvider([
      { type: "tool_call", toolName: "desktop_act", toolParams: { action: "focus" }, ...tokens },
      { type: "final_answer", text: "D'accord ?", ...tokens },
    ]);
    await runAgentLoop(first.provider, [desktop], "focus", ".", 3, () => undefined, undefined, undefined, {
      sessionId: "cancel-stale",
    });

    const second = fakeProvider([{ type: "final_answer", text: "Autre sujet.", ...tokens }]);
    await runAgentLoop(second.provider, [desktop], "Quelle heure est-il ?", ".", 2, () => undefined, undefined, undefined, {
      sessionId: "cancel-stale",
    });
    expect(executed).toHaveBeenCalledTimes(1);
    expect(hasPendingFastLaneApproval("cancel-stale")).toBe(false);
  });

  test("recognizes the affirmative phrases from the failing French voice trace", () => {
    expect(isExplicitAffirmative("Oui, tu peux.")).toBe(true);
    expect(isExplicitAffirmative("Oui, vas-y.")).toBe(true);
    expect(isExplicitAffirmative("Pour la troisième fois, vas-y.")).toBe(true);
    expect(isExplicitAffirmative("Non, ne le fais pas.")).toBe(false);
  });
});

describe("structured tool history", () => {
  test("tool exchanges are appended as tool_call/tool_result parts, never as bracket text", async () => {
    const { provider, observed } = fakeProvider([
      { type: "tool_call", toolName: "echo", toolParams: { value: 7 }, ...tokens },
      { type: "final_answer", text: "done", ...tokens },
    ]);
    const tool = fakeTool("echo", async (params) => `echoed ${params.value}`);

    const result = await runAgentLoop(provider, [tool], "go", ".", 3, () => undefined);

    expect(result.finalAnswer).toBe("done");
    const secondCallMessages = observed[1];
    expect(secondCallMessages.at(-2)?.content).toEqual([
      { type: "tool_call", name: "echo", args: { value: 7 } },
    ]);
    expect(secondCallMessages.at(-1)?.content).toEqual([
      { type: "tool_result", name: "echo", result: "echoed 7" },
    ]);
    // No message anywhere carries the imitable textual serialization.
    for (const message of secondCallMessages) {
      expect(messageText(message)).not.toContain("[tool_call:");
      expect(messageText(message)).not.toContain("[tool_result:");
    }
  });

  test("extra tool calls from one model response are executed in order", async () => {
    const executed: string[] = [];
    const { provider } = fakeProvider([
      {
        type: "tool_call",
        toolName: "fill",
        toolParams: { ref: "e8" },
        extraToolCalls: [{ toolName: "click", toolParams: { ref: "e2" } }],
        ...tokens,
      },
      { type: "final_answer", text: "done", ...tokens },
    ]);
    const fill = fakeTool("fill", async () => {
      executed.push("fill");
      return "filled";
    });
    const click = fakeTool("click", async () => {
      executed.push("click");
      return "clicked";
    });

    const result = await runAgentLoop(provider, [fill, click], "go", ".", 3, () => undefined);

    expect(executed).toEqual(["fill", "click"]);
    expect(result.toolCallsMade.map((c) => c.name)).toEqual(["fill", "click"]);
    expect(result.finalAnswer).toBe("done");
  });
});

describe("textual tool-call guardrail", () => {
  test("a final answer that is really a textual tool call gets executed, not returned", async () => {
    const executed: Array<Record<string, unknown>> = [];
    const { provider } = fakeProvider([
      {
        type: "final_answer",
        text: '[tool_call: browser_act({"action":"navigate","url":"https://quantamagazine.org"})]',
        ...tokens,
      },
      { type: "final_answer", text: "J'y suis.", ...tokens },
    ]);
    const tool = fakeTool("browser_act", async (params) => {
      executed.push(params);
      return "ok";
    });

    const result = await runAgentLoop(provider, [tool], "go", ".", 3, () => undefined);

    expect(executed).toEqual([{ action: "navigate", url: "https://quantamagazine.org" }]);
    expect(result.finalAnswer).toBe("J'y suis.");
    expect(result.toolCallsMade).toHaveLength(1);
  });

  test("an unknown tool or invalid JSON in the pattern is stripped, not executed", async () => {
    const { provider } = fakeProvider([
      {
        type: "final_answer",
        text: 'Voilà le résultat. [tool_call: no_such_tool({"a":1})]',
        ...tokens,
      },
    ]);

    const result = await runAgentLoop(provider, [], "go", ".", 3, () => undefined);
    expect(result.finalAnswer).toBe("Voilà le résultat.");
  });
});

describe("stripToolCallArtifacts", () => {
  test("removes leaked tool syntax and normalizes whitespace", () => {
    expect(stripToolCallArtifacts(
      'Je clique dessus.\n\n[tool_call: browser_act({"action":"click","ref":"e37"})]\n\nEt voilà.'
    )).toBe("Je clique dessus.\n\nEt voilà.");
    expect(stripToolCallArtifacts("[tool_result: browser_read] {json}")).toBe("");
    expect(stripToolCallArtifacts("Réponse normale.")).toBe("Réponse normale.");
  });
});
