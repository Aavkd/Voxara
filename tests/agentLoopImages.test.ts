import { runAgentLoop } from "../src/engine/agentLoop";
import { ILLMProvider } from "../src/providers/ILLMProvider";
import { IToolProvider } from "../src/providers/tools/IToolProvider";
import { Message } from "../src/types";

test("agent loop appends image tool results as multimodal content", async () => {
  let calls = 0;
  let observed: Message[] = [];
  const provider = {
    name: "fake vision",
    supportsImages: true,
    promptWithTools: async (messages: Message[]) => {
      calls += 1;
      if (calls === 1) {
        return {
          type: "tool_call" as const,
          toolName: "picture",
          toolParams: {},
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      observed = messages;
      return {
        type: "final_answer" as const,
        text: "seen",
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  } as unknown as ILLMProvider;
  const tool: IToolProvider = {
    name: "picture",
    description: "test",
    parameters: { type: "object" },
    async execute() {
      return {
        kind: "image",
        mimeType: "image/png",
        base64: "aW1hZ2U=",
        note: "look here",
      };
    },
  };

  const result = await runAgentLoop(provider, [tool], "look", ".", 3, () => undefined);

  expect(result.finalAnswer).toBe("seen");
  // The exchange is structured: tool_call part, functionResponse-compatible
  // tool_result part, then the image in its own user message.
  expect(observed.at(-3)?.content).toEqual([
    { type: "tool_call", name: "picture", args: {} },
  ]);
  expect(observed.at(-2)?.content).toEqual([
    { type: "tool_result", name: "picture", result: "look here" },
  ]);
  expect(observed.at(-1)?.content).toEqual([
    { type: "text", text: "Capture returned by picture: look here" },
    { type: "image", mimeType: "image/png", base64: "aW1hZ2U=" },
  ]);
});
