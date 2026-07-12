/**
 * Agent Loop Engine — runs a multi-step tool-use loop with an LLM provider.
 *
 * Phase C.3 (E1: Agentic Testing)
 */

import { ILLMProvider } from "../providers/ILLMProvider";
import { IToolProvider, ToolExecutionContext } from "../providers/tools/IToolProvider";
import { Message, AgentStepResult, ToolCallRecord } from "../types";

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

  while (stepIndex < maxSteps) {
    const stepResult = await provider.promptWithTools(messages, tools);

    // Notify the display layer
    onStep(stepResult);
    stepIndex++;

    if (stepResult.type === "final_answer") {
      return {
        finalAnswer: stepResult.text ?? "",
        toolCallsMade,
        steps: stepIndex,
      };
    }

    // type === "tool_call"
    const toolName = stepResult.toolName!;
    const toolParams = stepResult.toolParams ?? {};
    const tool = toolMap[toolName];

    let toolResult: unknown;
    if (!tool) {
      toolResult = `error: unknown tool "${toolName}"`;
    } else {
      try {
        toolResult = await tool.execute(toolParams, sandboxDir, toolContext);
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

    // Append the tool result to message history so the model can continue
    const toolResultContent =
      typeof toolResult === "string"
        ? toolResult
        : JSON.stringify(toolResult);

    messages.push({
      role: "model",
      content: `[tool_call: ${toolName}(${JSON.stringify(toolParams)})]`,
      timestamp: Date.now(),
    });
    messages.push({
      role: "user",
      content: `[tool_result: ${toolName}] ${toolResultContent}`,
      timestamp: Date.now(),
    });
  }

  // maxSteps reached without a final answer
  return {
    finalAnswer: "",
    toolCallsMade,
    steps: stepIndex,
    error: `max steps exceeded (limit: ${maxSteps})`,
  };
}
