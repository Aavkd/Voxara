import { runAgentLoop, stripToolCallArtifacts } from "../src/engine/agentLoop";
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
