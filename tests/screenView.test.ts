import { createScreenViewTool } from "../src/providers/tools/screenView";
import { ILLMProvider } from "../src/providers/ILLMProvider";
import { Message } from "../src/types";

const image = { kind: "image" as const, mimeType: "image/png" as const, base64: "aW1hZ2U=" };

describe("screen_view", () => {
  test("returns the image to an image-capable active provider", async () => {
    const journal = jest.fn();
    const tool = createScreenViewTool({
      capture: async () => image,
      journal,
      maxEdge: () => 900,
    });
    const activeProvider = { name: "vision", supportsImages: true } as ILLMProvider;

    await expect(tool.execute(
      { target: "screen", question: "What error is shown?" },
      ".",
      { sessionId: "session-a", activeProvider }
    )).resolves.toEqual({
      ...image,
      note: "Screen capture. Answer this question: What error is shown?",
    });
    expect(journal).toHaveBeenCalledWith(
      { sessionId: "session-a", target: "screen", outcome: "success" },
      image
    );
  });

  test("uses a vision side-call for a text-only active provider", async () => {
    let observed: Message[] = [];
    const visionProvider = {
      name: "fallback vision",
      supportsImages: true,
      chat: async (messages: Message[]) => {
        observed = messages;
        return {
          message: { role: "model" as const, content: "A settings window.", timestamp: 1 },
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    } as unknown as ILLMProvider;
    const tool = createScreenViewTool({
      capture: async () => image,
      journal: jest.fn(),
      maxEdge: () => 1568,
    });

    const result = await tool.execute(
      { target: "screen" },
      ".",
      {
        activeProvider: { name: "Ollama", supportsImages: false } as ILLMProvider,
        visionProvider,
      }
    );

    expect(result).toBe("A settings window.");
    expect(observed[0].content).toEqual([
      { type: "text", text: "Describe this screen capture clearly and concisely for the user." },
      { type: "image", mimeType: "image/png", base64: "aW1hZ2U=" },
    ]);
  });

  test("rejects the future browser tab target with relayable guidance", async () => {
    const tool = createScreenViewTool({ journal: jest.fn() });
    await expect(tool.execute({ target: "browser_tab" }, "."))
      .rejects.toThrow("C3b Chrome bridge");
  });
});
