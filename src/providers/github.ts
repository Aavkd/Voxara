/**
 * GitHub Copilot Provider — implements ILLMProvider using the OpenAI-compatible
 * GitHub Models inference endpoint (https://models.inference.ai.azure.com).
 *
 * Authentication: GitHub Personal Access Token (PAT) passed as Bearer token.
 */

import OpenAI from "openai";
import https from "https";
import { ILLMProvider } from "./ILLMProvider";
import {
  AppConfig,
  ValidationResult,
  PromptInput,
  PromptResult,
  Message,
  ChatResult,
  AgentStepResult,
} from "../types";
import type { IToolProvider } from "./tools/IToolProvider";

const GITHUB_MODELS_BASE_URL = "https://models.inference.ai.azure.com";

export class GitHubProvider implements ILLMProvider {
  public readonly name = "GitHub Copilot (Models)";

  private readonly client: OpenAI;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.client = new OpenAI({
      baseURL: GITHUB_MODELS_BASE_URL,
      apiKey: config.apiKey,
    });
  }

  /**
   * Validate the configured PAT by making a minimal test request.
   */
  async validate(): Promise<ValidationResult> {
    try {
      await this.client.chat.completions.create({
        model: this.config.model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      });
      return { valid: true };
    } catch (err: unknown) {
      const { code, message } = parseError(err);
      return {
        valid: false,
        errorCode: code,
        errorMessage: message,
      };
    }
  }

  /**
   * Send a single prompt and return the result with latency and token usage.
   */
  async prompt(input: PromptInput): Promise<PromptResult> {
    const modelName = input.model || this.config.model;

    if (input.image) {
      console.warn(
        "⚠  GitHub provider: image input is not supported — image will be ignored."
      );
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push({ role: "user", content: input.prompt });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestParams: any = {
      model: modelName,
      messages,
      temperature: input.temperature,
      max_tokens: input.maxTokens,
    };

    if (input.responseFormat === "json") {
      requestParams.response_format = { type: "json_object" };
    }

    const startMs = Date.now();
    const response = await this.client.chat.completions.create(requestParams);
    const latencyMs = Date.now() - startMs;

    const text = response.choices[0]?.message?.content ?? "";
    const usage = response.usage;

    return {
      text,
      latencyMs,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      finishReason: response.choices[0]?.finish_reason ?? "UNKNOWN",
    };
  }

  /**
   * Send a chat message using the full conversation history.
   * The last message in the array must be from the user.
   */
  async chat(messages: Message[]): Promise<ChatResult> {
    if (messages.length === 0) {
      throw new Error("chat() requires at least one message");
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== "user") {
      throw new Error("The last message must be from the user");
    }

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] =
      messages.map(toOpenAIMessage);

    const startMs = Date.now();
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: openaiMessages,
    });
    const latencyMs = Date.now() - startMs;

    const text = response.choices[0]?.message?.content ?? "";
    const usage = response.usage;

    return {
      message: {
        role: "model",
        content: text,
        timestamp: Date.now(),
      },
      latencyMs,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    };
  }

  /**
   * Stream a chat response, calling onChunk for each arriving piece of text.
   */
  async streamChat(
    messages: Message[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    if (messages.length === 0) {
      throw new Error("streamChat() requires at least one message");
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== "user") {
      throw new Error("The last message must be from the user");
    }

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] =
      messages.map(toOpenAIMessage);

    const startMs = Date.now();
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const chunk of stream) {
        if (signal?.aborted) {
          stream.controller.abort();
          break;
        }
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onChunk(delta);
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }
      }
    } catch (err) {
      // Aborting the underlying request makes the iterator throw; a caller
      // abort resolves with the partial text instead.
      if (!signal?.aborted) {
        throw err;
      }
    }

    const latencyMs = Date.now() - startMs;

    return {
      message: {
        role: "model",
        content: fullText,
        timestamp: Date.now(),
      },
      latencyMs,
      inputTokens,
      outputTokens,
    };
  }

  /**
   * List available models from the GitHub Models inference endpoint.
   * Falls back to a curated hardcoded list on failure.
   */
  async listModels(): Promise<string[]> {
    try {
      const data = await fetchJSON(
        `${GITHUB_MODELS_BASE_URL}/models`,
        this.config.apiKey
      );

      if (Array.isArray(data)) {
        const names = (data as Array<{ id?: string; name?: string }>)
          .map((m) => m.id ?? m.name ?? "")
          .filter((n) => n.length > 0);
        if (names.length > 0) return names;
      }

      if (!Array.isArray(data) && data.data && Array.isArray(data.data)) {
        const names = (data.data as Array<{ id?: string; name?: string }>)
          .map((m) => m.id ?? m.name ?? "")
          .filter((n) => n.length > 0);
        if (names.length > 0) return names;
      }

      // Endpoint returned something unexpected — use fallback
      return GITHUB_MODELS_FALLBACK;
    } catch (err: unknown) {
      const { message } = parseError(err);
      console.warn(`⚠  Could not fetch GitHub model list: ${message}`);
      return GITHUB_MODELS_FALLBACK;
    }
  }

  /**
   * Send a multi-turn message history with tool declarations to the model.
   * Returns a single AgentStepResult: either a tool_call or a final_answer.
   */
  async promptWithTools(
    messages: Message[],
    tools: IToolProvider[]
  ): Promise<AgentStepResult> {
    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] =
      messages.map(toOpenAIMessage);

    const openaiTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: t.parameters as any,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      tool_choice: openaiTools.length > 0 ? "auto" : undefined,
    });

    const usage = response.usage;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;

    const choice = response.choices[0];
    const toolCalls = choice?.message?.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      // Cast to concrete type — the SDK union includes CustomToolCall which lacks .function,
      // but the GitHub Models endpoint only returns standard function tool calls.
      const call = toolCalls[0] as { function: { name: string; arguments: string } };
      let toolParams: Record<string, unknown> = {};
      try {
        toolParams = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        // If parsing fails, pass empty params — the tool executor will handle it
      }

      return {
        type: "tool_call",
        toolName: call.function.name,
        toolParams,
        inputTokens,
        outputTokens,
      };
    }

    const text = choice?.message?.content ?? "";
    return {
      type: "final_answer",
      text,
      inputTokens,
      outputTokens,
    };
  }
}

// ── Fallback model list ───────────────────────────────────────────

const GITHUB_MODELS_FALLBACK: string[] = [
  "gpt-4o",
  "gpt-4o-mini",
  "Meta-Llama-3.1-405B-Instruct",
  "Meta-Llama-3.1-70B-Instruct",
  "Mistral-large",
  "Mistral-small",
  "Phi-3.5-MoE-instruct",
  "Phi-3.5-mini-instruct",
  "Cohere-command-r-plus",
  "Cohere-command-r",
];

// ── Module-level helpers ──────────────────────────────────────────

/**
 * Convert our Message type to the OpenAI message format.
 * Maps role "model" → "assistant".
 */
function toOpenAIMessage(
  msg: Message
): OpenAI.Chat.ChatCompletionMessageParam {
  return {
    role: msg.role === "model" ? "assistant" : "user",
    content: msg.content,
  };
}

/**
 * Parse an unknown error into a code and message pair.
 */
function parseError(err: unknown): { code: string; message: string } {
  if (err instanceof OpenAI.APIError) {
    const code = String(err.status ?? "UNKNOWN_ERROR");
    const msg = err.message;
    if (err.status === 401 || msg.includes("Unauthorized") || msg.includes("invalid")) {
      return { code: "TOKEN_INVALID", message: msg };
    }
    if (err.status === 403 || msg.includes("Forbidden")) {
      return { code: "PERMISSION_DENIED", message: msg };
    }
    if (err.status === 429 || msg.includes("rate limit") || msg.includes("quota")) {
      return { code: "RATE_LIMIT_EXCEEDED", message: msg };
    }
    if (err.status === 404 || msg.includes("not found")) {
      return { code: "MODEL_NOT_FOUND", message: msg };
    }
    return { code, message: msg };
  }

  if (err instanceof Error) {
    return { code: "UNKNOWN_ERROR", message: err.message };
  }

  return { code: "UNKNOWN_ERROR", message: String(err) };
}

/**
 * Simple HTTPS GET with Bearer auth that returns parsed JSON.
 */
function fetchJSON(
  url: string,
  token: string
): Promise<Record<string, unknown> | unknown[]> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };

    https
      .request(options, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed as Record<string, unknown>);
          } catch (e) {
            reject(
              new Error(`Failed to parse JSON response: ${body.slice(0, 200)}`)
            );
          }
        });
      })
      .on("error", (err) => {
        reject(err);
      })
      .end();
  });
}
