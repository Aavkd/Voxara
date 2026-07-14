/**
 * IToolProvider — Interface that every built-in (and future) tool must implement.
 *
 * Phase C.1 (E1: Agentic Testing)
 */

import { Message } from "../../types";
import type { ILLMProvider } from "../ILLMProvider";

export interface ToolExecutionContext {
  /** Trusted session metadata supplied by the application, never by the model. */
  sessionId?: string;
  conversationMessages?: Message[];
  /** Active conversational provider, injected by the agent loop. */
  activeProvider?: ILLMProvider;
  /** Optional injected fallback provider (primarily useful for tests). */
  visionProvider?: ILLMProvider;
  /**
   * Trusted approval bit set only by application code after consuming an
   * explicit user confirmation. Tool parameters come from the model and must
   * never be treated as proof of consent.
   */
  controlApproved?: boolean;
  /**
   * Which control lane this call runs in (phase C3 §9.6). Set to "pilot" by
   * the pilot service; fast-lane acting tools refuse while a pilot runs.
   */
  controlLane?: "fast" | "pilot";
}

export interface IToolProvider {
  /** Unique tool name used in suite JSON and Gemini function declarations. */
  name: string;

  /** Human-readable description passed to the model. */
  description: string;

  /**
   * JSON Schema object describing the tool's accepted parameters.
   * Passed verbatim to the model as the function's parameter schema.
   */
  parameters: Record<string, unknown>;

  /**
   * Execute the tool with the given parameters inside the sandbox directory.
   *
   * @param params     - The parameters extracted from the model's function call.
   * @param sandboxDir - The absolute path of the sandboxed working directory.
   * @returns          - The tool result (string, number, object, etc.)
   */
  execute(
    params: Record<string, unknown>,
    sandboxDir: string,
    context?: ToolExecutionContext
  ): Promise<unknown>;
}
