/**
 * Ollama Provider - implements ILLMProvider using Ollama's native local API.
 */

import http from "http";
import https from "https";
import { ILLMProvider } from "./ILLMProvider";
import {
  AppConfig,
  ValidationResult,
  PromptInput,
  PromptResult,
  Message,
  ChatResult,
} from "../types";

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatResponse {
  message?: OllamaChatMessage;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
}

export class OllamaProvider implements ILLMProvider {
  public readonly name = "Ollama";

  private readonly config: AppConfig;
  private readonly baseUrl: string;

  constructor(config: AppConfig) {
    this.config = config;
    this.baseUrl = normalizeBaseUrl(config.ollamaBaseUrl ?? "http://localhost:11434");
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.prompt({
        prompt: "hi",
        maxTokens: 1,
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

  async prompt(input: PromptInput): Promise<PromptResult> {
    if (input.image) {
      console.warn("Ollama provider: image input is not supported - image will be ignored.");
    }

    const messages: OllamaChatMessage[] = [];
    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push({ role: "user", content: input.prompt });

    const startMs = Date.now();
    const response = await this.postChat({
      model: input.model || this.config.model,
      messages,
      stream: false,
      format: getResponseFormat(input),
      options: getOptions(input),
    });
    const latencyMs = Date.now() - startMs;

    if (response.error) {
      throw new Error(response.error);
    }

    const inputTokens = response.prompt_eval_count ?? 0;
    const outputTokens = response.eval_count ?? 0;

    return {
      text: response.message?.content ?? "",
      latencyMs,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      finishReason: response.done_reason ?? "stop",
    };
  }

  async chat(messages: Message[]): Promise<ChatResult> {
    assertUserFinalMessage(messages, "chat");

    const startMs = Date.now();
    const response = await this.postChat({
      model: this.config.model,
      messages: messages.map(toOllamaMessage),
      stream: false,
    });
    const latencyMs = Date.now() - startMs;

    if (response.error) {
      throw new Error(response.error);
    }

    return {
      message: {
        role: "model",
        content: response.message?.content ?? "",
        timestamp: Date.now(),
      },
      latencyMs,
      inputTokens: response.prompt_eval_count ?? 0,
      outputTokens: response.eval_count ?? 0,
    };
  }

  async streamChat(
    messages: Message[],
    onChunk: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    assertUserFinalMessage(messages, "streamChat");

    const startMs = Date.now();
    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    await postStreamingJsonLines<OllamaChatResponse>(
      `${this.baseUrl}/api/chat`,
      {
        model: this.config.model,
        messages: messages.map(toOllamaMessage),
        stream: true,
      },
      (event) => {
        if (event.error) {
          throw new Error(event.error);
        }

        const chunk = event.message?.content ?? "";
        if (chunk) {
          fullText += chunk;
          onChunk(chunk);
        }

        if (event.done) {
          inputTokens = event.prompt_eval_count ?? inputTokens;
          outputTokens = event.eval_count ?? outputTokens;
        }
      },
      signal
    );

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

  async listModels(): Promise<string[]> {
    const response = await getJson<OllamaTagsResponse>(`${this.baseUrl}/api/tags`);
    return (response.models ?? [])
      .map((model) => model.name ?? model.model ?? "")
      .filter((name) => name.length > 0)
      .sort((a, b) => a.localeCompare(b));
  }

  private postChat(body: Record<string, unknown>): Promise<OllamaChatResponse> {
    return postJson<OllamaChatResponse>(`${this.baseUrl}/api/chat`, body);
  }
}

function assertUserFinalMessage(messages: Message[], methodName: string): void {
  if (messages.length === 0) {
    throw new Error(`${methodName}() requires at least one message`);
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role !== "user") {
    throw new Error("The last message must be from the user");
  }
}

function toOllamaMessage(msg: Message): OllamaChatMessage {
  return {
    role: msg.role === "model" ? "assistant" : "user",
    content: msg.content,
  };
}

function getOptions(input: PromptInput): Record<string, number> | undefined {
  const options: Record<string, number> = {};
  if (input.temperature !== undefined) {
    options.temperature = input.temperature;
  }
  if (input.maxTokens !== undefined) {
    options.num_predict = input.maxTokens;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function getResponseFormat(input: PromptInput): "json" | Record<string, unknown> | undefined {
  if (input.responseFormat !== "json") {
    return undefined;
  }
  return input.responseSchema ?? "json";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function getJson<T>(url: string): Promise<T> {
  return requestJson<T>("GET", url);
}

function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  return requestJson<T>("POST", url, body);
}

function requestJson<T>(
  method: "GET" | "POST",
  url: string,
  body?: Record<string, unknown>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = body ? JSON.stringify(omitUndefined(body)) : undefined;
    const client = urlObj.protocol === "https:" ? https : http;

    const req = client.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(formatHttpError(res.statusCode, text)));
            return;
          }

          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error(`Failed to parse Ollama JSON response: ${text.slice(0, 200)}`));
          }
        });
      }
    );

    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function postStreamingJsonLines<T>(
  url: string,
  body: Record<string, unknown>,
  onEvent: (event: T) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = JSON.stringify(omitUndefined(body));
    const client = urlObj.protocol === "https:" ? https : http;
    let buffer = "";
    let settled = false;
    const errorChunks: Buffer[] = [];

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    // An abort resolves (with the events received so far already delivered)
    // rather than rejecting: callers treat cancellation as a partial result.
    const onAbort = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
      req.destroy();
    };

    const req = client.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;

        res.on("data", (chunk: Buffer) => {
          if (statusCode >= 400) {
            errorChunks.push(chunk);
            return;
          }

          buffer += chunk.toString("utf8");
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            parseStreamingLine(line, onEvent, fail);
          }
        });

        res.on("end", () => {
          if (settled) return;

          if (statusCode >= 400) {
            settled = true;
            reject(
              new Error(
                formatHttpError(statusCode, Buffer.concat(errorChunks).toString("utf8"))
              )
            );
            return;
          }

          if (buffer.trim().length > 0) {
            parseStreamingLine(buffer, onEvent, fail);
          }

          if (!settled) {
            settled = true;
            resolve();
          }
        });

        res.on("close", () => signal?.removeEventListener("abort", onAbort));
      }
    );

    req.on("error", fail);
    req.write(payload);
    req.end();

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

function parseStreamingLine<T>(
  line: string,
  onEvent: (event: T) => void,
  fail: (err: Error) => void
): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  try {
    onEvent(JSON.parse(trimmed) as T);
  } catch (err: unknown) {
    fail(err instanceof Error ? err : new Error(String(err)));
  }
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

function formatHttpError(statusCode: number | undefined, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `Ollama HTTP ${statusCode ?? "error"}`;
  }

  try {
    const parsed = JSON.parse(trimmed) as { error?: string };
    if (parsed.error) {
      return `Ollama HTTP ${statusCode ?? "error"}: ${parsed.error}`;
    }
  } catch {
    // Use the raw body below.
  }

  return `Ollama HTTP ${statusCode ?? "error"}: ${trimmed.slice(0, 200)}`;
}

function parseError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    if (err.message.includes("ECONNREFUSED")) {
      return {
        code: "OLLAMA_UNAVAILABLE",
        message: `Could not connect to Ollama at ${err.message}`,
      };
    }
    if (err.message.includes("not found") || err.message.includes("404")) {
      return { code: "MODEL_NOT_FOUND", message: err.message };
    }
    return { code: "OLLAMA_ERROR", message: err.message };
  }

  return { code: "OLLAMA_ERROR", message: String(err) };
}
