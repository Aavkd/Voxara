/**
 * Agent Loop Engine — runs a multi-step tool-use loop with an LLM provider.
 *
 * Phase C.3 (E1: Agentic Testing)
 */

import { ILLMProvider } from "../providers/ILLMProvider";
import { IToolProvider, ToolExecutionContext } from "../providers/tools/IToolProvider";
import {
  rememberFastLaneApproval,
  takeApprovedFastLaneAction,
} from "../control/fastLaneApproval";
import { Message, AgentStepResult, ToolCallRecord, messageText } from "../types";

/** Return value of a completed agent loop run. */
export interface AgentLoopResult {
  finalAnswer: string;
  toolCallsMade: ToolCallRecord[];
  steps: number;
  error?: string;
}

/**
 * Run the agent loop until the provider returns a final_answer or maxSteps is reached.
 *
 * @param provider      - The LLM provider (must implement promptWithTools).
 * @param tools         - The tool implementations available to the agent.
 * @param initialPrompt - The user's initial prompt string.
 * @param sandboxDir    - The absolute sandbox directory path for file tools.
 * @param maxSteps      - Maximum number of loop iterations before giving up.
 * @param onStep        - Callback invoked after every step (for live display).
 * @param onToolResult  - Optional callback invoked after each tool execution.
 * @param priorMessages - Optional conversation history (and/or instruction
 *                        preamble) placed before the initial prompt.
 * @returns             - The final answer, all tool calls made, and step count.
 */
export async function runAgentLoop(
  provider: ILLMProvider,
  tools: IToolProvider[],
  initialPrompt: string,
  sandboxDir: string,
  maxSteps: number,
  onStep: (step: AgentStepResult) => void,
  onToolResult?: (toolCall: ToolCallRecord) => void,
  priorMessages?: Message[],
  toolContext?: ToolExecutionContext
): Promise<AgentLoopResult> {
  if (!provider.promptWithTools) {
    throw new Error(
      `Provider "${provider.name}" does not support tool use (promptWithTools is not implemented).`
    );
  }

  const messages: Message[] = [
    ...(priorMessages ?? []),
    { role: "user", content: initialPrompt, timestamp: Date.now() },
  ];

  const toolCallsMade: ToolCallRecord[] = [];
  let stepIndex = 0;

  // Build a quick lookup map for tools by name
  const toolMap: Record<string, IToolProvider> = {};
  for (const tool of tools) {
    toolMap[tool.name] = tool;
  }

  // Resume an EXACT blocked control call after the user's next explicit yes.
  // This happens before asking the model, so neither the action/target nor the
  // approval bit can drift in model-generated arguments between turns.
  const latestUserText = latestConversationUserText(toolContext) ?? initialPrompt;
  const approvedPending = takeApprovedFastLaneAction(
    toolContext?.sessionId,
    latestUserText
  );
  if (approvedPending) {
    const { toolName, toolParams } = approvedPending;
    const tool = toolMap[toolName];
    onStep({
      type: "tool_call",
      toolName,
      toolParams,
      inputTokens: 0,
      outputTokens: 0,
    });

    let toolResult: unknown;
    if (!tool) {
      toolResult = `error: unknown tool "${toolName}"`;
    } else {
      try {
        toolResult = await tool.execute(toolParams, sandboxDir, {
          ...toolContext,
          activeProvider: provider,
          controlApproved: true,
        });
      } catch (err: unknown) {
        toolResult = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const approvedRecord: ToolCallRecord = {
      name: toolName,
      params: toolParams,
      result: toolResult,
      stepIndex: -1,
    };
    toolCallsMade.push(approvedRecord);
    onToolResult?.(approvedRecord);
    rememberFastLaneApproval(
      toolContext?.sessionId,
      toolName,
      toolParams,
      toolResult
    );
    appendStructuredToolExchange(messages, toolName, toolParams, toolResult);
  }

  while (stepIndex < maxSteps) {
    const stepResult = await provider.promptWithTools(messages, tools);

    // Notify the display layer
    onStep(stepResult);
    stepIndex++;

    // Determine the tool calls this step carries. A "final answer" that is
    // really a tool call written as text (a small-model failure mode: the
    // syntax leaks into speech) is intercepted and executed instead of
    // being returned — the guardrail behind the 2026-07-13 live finding.
    let calls: Array<{
      toolName: string;
      toolParams: Record<string, unknown>;
      thoughtSignature?: string;
    }>;
    if (stepResult.type === "final_answer") {
      const textual = extractTextualToolCall(stepResult.text ?? "", toolMap);
      if (!textual) {
        return {
          finalAnswer: stripToolCallArtifacts(stepResult.text ?? ""),
          toolCallsMade,
          steps: stepIndex,
        };
      }
      calls = [textual];
    } else {
      calls = [
        {
          toolName: stepResult.toolName!,
          toolParams: stepResult.toolParams ?? {},
          thoughtSignature: stepResult.thoughtSignature,
        },
        ...(stepResult.extraToolCalls ?? []),
      ];
    }

    for (const { toolName, toolParams, thoughtSignature } of calls) {
      const tool = toolMap[toolName];

      let toolResult: unknown;
      if (!tool) {
        toolResult = `error: unknown tool "${toolName}"`;
      } else {
        try {
          toolResult = await tool.execute(toolParams, sandboxDir, {
            ...toolContext,
            activeProvider: provider,
          });
        } catch (err: unknown) {
          toolResult = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Record the tool call
      const toolCallRecord: ToolCallRecord = {
        name: toolName,
        params: toolParams,
        result: toolResult,
        stepIndex: stepIndex - 1,
      };
      toolCallsMade.push(toolCallRecord);
      onToolResult?.(toolCallRecord);
      rememberFastLaneApproval(
        toolContext?.sessionId,
        toolName,
        toolParams,
        toolResult
      );

      // Append the exchange as STRUCTURED parts, never as imitable text:
      // providers with native function calling (Gemini) replay them as
      // functionCall/functionResponse, text-only providers get the
      // descriptive messageText() rendering.
      appendStructuredToolExchange(
        messages,
        toolName,
        toolParams,
        toolResult,
        thoughtSignature
      );
    }
  }

  // maxSteps reached without a final answer
  return {
    finalAnswer: "",
    toolCallsMade,
    steps: stepIndex,
    error: `max steps exceeded (limit: ${maxSteps})`,
  };
}

function latestConversationUserText(
  context: ToolExecutionContext | undefined
): string | undefined {
  const messages = context?.conversationMessages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messageText(messages[i]);
    }
  }
  return undefined;
}

function appendStructuredToolExchange(
  messages: Message[],
  toolName: string,
  toolParams: Record<string, unknown>,
  toolResult: unknown,
  thoughtSignature?: string
): void {
  const imageResult = asImageToolResult(toolResult);
  messages.push({
    role: "model",
    content: [
      {
        type: "tool_call",
        name: toolName,
        args: toolParams,
        thoughtSignature,
      },
    ],
    timestamp: Date.now(),
  });
  messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        name: toolName,
        result: imageResult
          ? imageResult.note ?? "image captured — attached in the next message"
          : typeof toolResult === "string"
            ? toolResult
            : JSON.stringify(toolResult),
      },
    ],
    timestamp: Date.now(),
  });
  if (imageResult) {
    // The image travels in its own user message: Gemini accepts inline data
    // beside text parts, but not inside a functionResponse.
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `Capture returned by ${toolName}:${imageResult.note ? ` ${imageResult.note}` : ""}`,
        },
        {
          type: "image",
          mimeType: imageResult.mimeType,
          base64: imageResult.base64,
        },
      ],
      timestamp: Date.now(),
    });
  }
}

/**
 * Matches the legacy textual serialization of a tool call — the exact syntax
 * older histories taught the model to imitate. Kept permissive on
 * whitespace; the JSON body must parse to count as executable.
 */
const TEXTUAL_TOOL_CALL_PATTERN = /\[tool_call:\s*([a-zA-Z0-9_-]+)\s*\((\{[\s\S]*?\})\)\s*\]/;

/**
 * Extract the first executable tool call a model wrote as TEXT instead of a
 * native function call. Returns null when there is none — or when the match
 * cannot be executed (unknown tool, unparseable JSON), in which case the
 * text is a final answer to sanitize, not to run.
 */
function extractTextualToolCall(
  text: string,
  toolMap: Record<string, IToolProvider>
): { toolName: string; toolParams: Record<string, unknown> } | null {
  const match = TEXTUAL_TOOL_CALL_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const [, toolName, rawArgs] = match;
  if (!toolMap[toolName]) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return { toolName, toolParams: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Strip leaked tool-call/result syntax from a final answer so it is never
 * spoken by TTS or persisted into the session history (where the model
 * would imitate it in every later turn). Exported for the voice pipeline.
 */
export function stripToolCallArtifacts(text: string): string {
  return text
    .replace(/\[tool_call:\s*[a-zA-Z0-9_-]+\s*\([\s\S]*?\)\s*\]/g, "")
    .replace(/\[tool_result:\s*[a-zA-Z0-9_-]+\][^\n]*/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface ImageToolResult {
  kind: "image";
  mimeType: "image/png" | "image/jpeg";
  base64: string;
  note?: string;
}

function asImageToolResult(value: unknown): ImageToolResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ImageToolResult>;
  if (
    candidate.kind !== "image" ||
    (candidate.mimeType !== "image/png" && candidate.mimeType !== "image/jpeg") ||
    typeof candidate.base64 !== "string"
  ) {
    return null;
  }
  return candidate as ImageToolResult;
}
