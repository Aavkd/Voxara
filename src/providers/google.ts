/**
 * Google Gemini Provider — implements ILLMProvider using the @google/generative-ai SDK.
 */

import {
  GoogleGenerativeAI,
  GenerativeModel,
  ChatSession,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";
import https from "https";
import { ILLMProvider } from "./ILLMProvider";
import { loadImage } from "./imageLoader";
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

export class GoogleProvider implements ILLMProvider {
  public readonly name = "Google Gemini";

  private readonly client: GoogleGenerativeAI;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.client = new GoogleGenerativeAI(config.apiKey);
  }

  /**
   * Validate the configured API key by making a minimal test request.
   */
  async validate(): Promise<ValidationResult> {
    try {
      const model = this.getModel(this.config.model);
      await model.generateContent("hi");
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
    const jsonConfig = input.responseFormat === "json"
      ? {
          responseMimeType: "application/json" as const,
          responseSchema: input.responseSchema,
        }
      : {};

    const model = this.getModel(modelName, {
      temperature: input.temperature,
      maxOutputTokens: input.maxTokens,
      ...jsonConfig,
    });

    const startMs = Date.now();

    // E7: Build multi-part content when an image path is provided
    let content: string | { text?: string; inlineData?: { mimeType: string; data: string } }[];
    if (input.image) {
      const { mimeType, data } = await loadImage(input.image);
      content = [{ text: input.prompt }, { inlineData: { mimeType, data } }];
    } else {
      content = input.prompt;
    }

    const result = input.systemPrompt
      ? await this.getModelWithSystem(modelName, input.systemPrompt, {
          temperature: input.temperature,
          maxOutputTokens: input.maxTokens,
          ...jsonConfig,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }).generateContent(content as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : await model.generateContent(content as any);

    const latencyMs = Date.now() - startMs;

    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    return {
      text,
      latencyMs,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      totalTokens: usage?.totalTokenCount ?? 0,
      finishReason: response.candidates?.[0]?.finishReason ?? "UNKNOWN",
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

    const history = messages.slice(0, -1).map(toGeminiMessage);
    const model = this.getModel(this.config.model);
    const chatSession = model.startChat({ history });

    const startMs = Date.now();
    const result = await chatSession.sendMessage(lastMessage.content);
    const latencyMs = Date.now() - startMs;

    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    return {
      message: {
        role: "model",
        content: text,
        timestamp: Date.now(),
      },
      latencyMs,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
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

    const history = messages.slice(0, -1).map(toGeminiMessage);
    const model = this.getModel(this.config.model);
    const chatSession = model.startChat({ history });

    const startMs = Date.now();
    const streamResult = await chatSession.sendMessageStream(
      lastMessage.content
    );

    let fullText = "";
    for await (const chunk of streamResult.stream) {
      if (signal?.aborted) {
        break;
      }
      const chunkText = chunk.text();
      if (chunkText) {
        fullText += chunkText;
        onChunk(chunkText);
      }
    }

    const latencyMs = Date.now() - startMs;

    if (signal?.aborted) {
      // Do not await the aggregated response: it only resolves once the model
      // finishes generating, which is exactly what an abort must not wait for.
      return {
        message: { role: "model", content: fullText, timestamp: Date.now() },
        latencyMs,
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    // Get final aggregated response for token usage
    const aggregated = await streamResult.response;
    const usage = aggregated.usageMetadata;

    return {
      message: {
        role: "model",
        content: fullText,
        timestamp: Date.now(),
      },
      latencyMs,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }

  /**
   * List available models via the Gemini REST API.
   * Returns an empty array and logs a warning if the endpoint is unavailable.
   */
  async listModels(): Promise<string[]> {
    try {
      const data = await fetchJSON(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${this.config.apiKey}`
      );

      if (data.models && Array.isArray(data.models)) {
        return data.models.map(
          (m: { name?: string }) => m.name?.replace("models/", "") ?? ""
        ).filter((n: string) => n.length > 0);
      }

      return [];
    } catch (err: unknown) {
      const { message } = parseError(err);
      console.warn(`⚠  Could not fetch model list: ${message}`);
      return [];
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
    const modelName = this.config.model;

    // Convert IToolProvider[] to Gemini FunctionDeclaration format
    const functionDeclarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // Cast to any[] — IToolProvider.parameters is a valid JSON Schema object at
    // runtime but the SDK's FunctionDeclarationSchema type requires explicit
    // `type` and `properties` fields that TypeScript can't infer from Record<string, unknown>.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const geminiTools: any[] | undefined = functionDeclarations.length > 0
      ? [{ functionDeclarations }]
      : undefined;

    const model = this.client.getGenerativeModel({
      model: modelName,
      tools: geminiTools,
    });

    // Convert our Message[] to Gemini Content[] format
    const history = messages.slice(0, -1).map(toGeminiMessage);
    const lastMessage = messages[messages.length - 1];

    const chatSession = model.startChat({ history });
    const result = await chatSession.sendMessage(lastMessage.content);

    const response = result.response;
    const usage = response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    // Check if the model issued a function call
    const functionCallPart = parts.find(
      (p) => (p as unknown as Record<string, unknown>).functionCall !== undefined
    ) as { functionCall: { name: string; args: Record<string, unknown> } } | undefined;

    if (functionCallPart?.functionCall) {
      const { name, args } = functionCallPart.functionCall;
      return {
        type: "tool_call",
        toolName: name,
        toolParams: args ?? {},
        inputTokens,
        outputTokens,
      };
    }

    // Otherwise, treat the response as a final text answer
    const text = response.text();
    return {
      type: "final_answer",
      text,
      inputTokens,
      outputTokens,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Create a GenerativeModel instance with optional generation config.
   */
  private getModel(
    modelName: string,
    generationConfig?: {
      temperature?: number;
      maxOutputTokens?: number;
      responseMimeType?: string;
      responseSchema?: Record<string, unknown>;
    }
  ): GenerativeModel {
    return this.client.getGenerativeModel({
      model: modelName,
      generationConfig: generationConfig
        ? {
            temperature: generationConfig.temperature,
            maxOutputTokens: generationConfig.maxOutputTokens,
            responseMimeType: generationConfig.responseMimeType,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            responseSchema: generationConfig.responseSchema as any,
          }
        : undefined,
    });
  }

  /**
   * Create a GenerativeModel instance with a system instruction.
   */
  private getModelWithSystem(
    modelName: string,
    systemPrompt: string,
    generationConfig?: {
      temperature?: number;
      maxOutputTokens?: number;
      responseMimeType?: string;
      responseSchema?: Record<string, unknown>;
    }
  ): GenerativeModel {
    return this.client.getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
      generationConfig: generationConfig
        ? {
            temperature: generationConfig.temperature,
            maxOutputTokens: generationConfig.maxOutputTokens,
            responseMimeType: generationConfig.responseMimeType,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            responseSchema: generationConfig.responseSchema as any,
          }
        : undefined,
    });
  }
}

// ── Module-level helpers ──────────────────────────────────────────

/**
 * Convert our Message type to the Gemini SDK's Content format.
 */
function toGeminiMessage(msg: Message): { role: string; parts: { text: string }[] } {
  return {
    role: msg.role === "model" ? "model" : "user",
    parts: [{ text: msg.content }],
  };
}

/**
 * Parse an unknown error into a code and message.
 */
function parseError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    // The GoogleGenerativeAI SDK uses specific error types with status codes
    const errAny = err as unknown as Record<string, unknown>;
    const status = errAny.status ?? errAny.statusCode ?? errAny.code;
    const code = status ? String(status) : "UNKNOWN_ERROR";

    // Try to extract a more specific error code from the message
    const msg = err.message;
    if (msg.includes("API_KEY_INVALID") || msg.includes("API key not valid")) {
      return { code: "API_KEY_INVALID", message: msg };
    }
    if (msg.includes("PERMISSION_DENIED")) {
      return { code: "PERMISSION_DENIED", message: msg };
    }
    if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
      return { code: "QUOTA_EXCEEDED", message: msg };
    }
    if (msg.includes("NOT_FOUND") || msg.includes("404")) {
      return { code: "MODEL_NOT_FOUND", message: msg };
    }

    return { code, message: msg };
  }

  return { code: "UNKNOWN_ERROR", message: String(err) };
}

/**
 * Simple HTTPS GET that returns parsed JSON.
 * Uses Node's built-in https module — no extra dependency.
 */
function fetchJSON(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch (e) {
            reject(new Error(`Failed to parse JSON response: ${body.slice(0, 200)}`));
          }
        });
      })
      .on("error", (err) => {
        reject(err);
      });
  });
}
