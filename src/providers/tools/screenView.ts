import { loadControlScreenshotMaxEdge, loadControlVisionConfig } from "../../config/loader";
import { captureScreen } from "../../control/screenCapture";
import { BrowserExecutor, getBrowserExecutor } from "../../control/executor";
import { journalScreenView } from "../../control/journal";
import { ScreenImageResult, ScreenTarget } from "../../control/types";
import { createProvider } from "../factory";
import { ILLMProvider } from "../ILLMProvider";
import { IToolProvider, ToolExecutionContext } from "./IToolProvider";

interface ScreenViewDependencies {
  capture?: typeof captureScreen;
  journal?: typeof journalScreenView;
  createVisionProvider?: () => ILLMProvider;
  maxEdge?: () => number;
  /** Browser channel for target=browser_tab (C3b); injectable in tests. */
  browserExecutor?: () => BrowserExecutor;
}

export function createScreenViewTool(
  dependencies: ScreenViewDependencies = {}
): IToolProvider {
  const capture = dependencies.capture ?? captureScreen;
  const journal = dependencies.journal ?? journalScreenView;

  return {
    name: "screen_view",
    description:
      "Capture and inspect the user's current Windows screen, a visible window, or the " +
      "active Chrome tab (target=browser_tab, via the paired extension — sharper and " +
      "cheaper than a full-screen capture when the content is in the browser). " +
      "Use only when the user asks you to look at their screen. The capture may be sent " +
      "to the configured cloud vision provider and therefore leave the machine.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["screen", "window", "browser_tab"],
          description: "What to capture.",
        },
        window_title: {
          type: "string",
          description: "Case-insensitive title fragment; required for target=window.",
        },
        question: {
          type: "string",
          description: "Optional detail to find or question to answer from the capture.",
        },
      },
      required: ["target"],
    },
    async execute(
      params: Record<string, unknown>,
      _sandboxDir: string,
      context?: ToolExecutionContext
    ): Promise<unknown> {
      const target = parseTarget(params.target);
      const windowTitle = typeof params.window_title === "string"
        ? params.window_title.trim()
        : undefined;
      const question = typeof params.question === "string" ? params.question.trim() : "";
      const sessionId = context?.sessionId || "unscoped";
      const targetSummary = target === "window" ? `window:${windowTitle || "(missing)"}` : target;
      let image: ScreenImageResult | undefined;

      try {
        if (target === "window" && !windowTitle) {
          throw new Error("window_title is required when target is window");
        }
        if (target === "browser_tab") {
          image = await (dependencies.browserExecutor ?? getBrowserExecutor)().screenshot();
        } else {
          image = await capture({
            target,
            windowTitle,
            maxEdge: (dependencies.maxEdge ?? loadControlScreenshotMaxEdge)(),
          });
        }

        let result: unknown;
        if (context?.activeProvider?.supportsImages) {
          result = {
            ...image,
            note: question
              ? `Screen capture. Answer this question: ${question}`
              : "Screen capture requested by the user. Describe the relevant visible content.",
          };
        } else {
          const visionProvider = context?.visionProvider ??
            (dependencies.createVisionProvider ?? (() => createProvider(loadControlVisionConfig())))();
          if (!visionProvider.supportsImages) {
            throw new Error(
              `configured vision provider "${visionProvider.name}" does not support images`
            );
          }
          const prompt = question
            ? `Inspect this screen capture and answer the user's question precisely: ${question}`
            : "Describe this screen capture clearly and concisely for the user.";
          const description = await visionProvider.chat([
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image", mimeType: image.mimeType, base64: image.base64 },
              ],
              timestamp: Date.now(),
            },
          ]);
          result = typeof description.message.content === "string"
            ? description.message.content
            : description.message.content
                .filter((part) => part.type === "text")
                .map((part) => part.type === "text" ? part.text : "")
                .join("\n");
        }

        journal({ sessionId, target: targetSummary, outcome: "success" }, image);
        return result;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        journal({
          sessionId,
          target: targetSummary,
          outcome: "error",
          error: message,
        }, image);
        throw error;
      }
    },
  };
}

function parseTarget(value: unknown): ScreenTarget {
  if (value === "screen" || value === "window" || value === "browser_tab") {
    return value;
  }
  throw new Error('target must be "screen", "window", or "browser_tab"');
}

export default createScreenViewTool();
