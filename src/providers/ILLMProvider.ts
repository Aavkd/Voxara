/**
 * ILLMProvider — Provider interface for LLM backends.
 *
 * All provider implementations must satisfy this interface,
 * ensuring future providers (OpenAI, Anthropic, etc.) are drop-in additions.
 */

import {
  ValidationResult,
  PromptInput,
  PromptResult,
  Message,
  ChatResult,
  AgentStepResult,
} from "../types";
import type { IToolProvider } from "./tools/IToolProvider";

export interface ILLMProvider {
  /** Human-readable provider name (e.g., "Google Gemini"). */
  name: string;

  /** Whether conversational messages may contain image content parts. */
  readonly supportsImages?: boolean;

  /** Validate the configured API key. */
  validate(): Promise<ValidationResult>;

  /** Send a single prompt and return the result. */
  prompt(input: PromptInput): Promise<PromptResult>;

  /** Send a chat message using the full conversation history. */
  chat(messages: Message[]): Promise<ChatResult>;

  /**
   * Stream a chat response, calling onChunk for each arriving piece of text.
   *
   * When `signal` aborts mid-stream, the provider stops consuming (cancelling
   * the underlying request where the transport allows it) and resolves with
   * the partial text received so far instead of rejecting — callers use this
   * for voice barge-in, where the partial answer is still recorded.
   */
  streamChat(
    messages: Message[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<ChatResult>;

  /** List available models for the configured key. Optional — not all providers support this. */
  listModels?(): Promise<string[]>;

  /**
   * Send a multi-turn message history with tool declarations to the model.
   * Returns a single step: either a tool_call (function call) or a final_answer (text).
   *
   * Optional — providers that don't support tool use may omit this.
   */
  promptWithTools?(
    messages: Message[],
    tools: IToolProvider[]
  ): Promise<AgentStepResult>;
}
