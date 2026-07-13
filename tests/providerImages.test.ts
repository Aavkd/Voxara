import { toGeminiFunctionParameters, toGeminiMessage, toGeminiParts } from "../src/providers/google";
import { messageText } from "../src/types";

describe("provider-generic image messages", () => {
  test("Google maps image content to inlineData", () => {
    expect(toGeminiParts([
      { type: "text", text: "What is visible?" },
      { type: "image", mimeType: "image/png", base64: "cG5n" },
    ])).toEqual([
      { text: "What is visible?" },
      { inlineData: { mimeType: "image/png", data: "cG5n" } },
    ]);
  });

  test("Google maps tool exchanges to native functionCall/functionResponse parts", () => {
    // The model's thought signature is echoed verbatim; a call the model did
    // not produce gets the documented skip placeholder instead of a 400.
    expect(toGeminiParts([
      { type: "tool_call", name: "browser_act", args: { action: "click", ref: "e2" }, thoughtSignature: "sig123" },
    ])).toEqual([
      { functionCall: { name: "browser_act", args: { action: "click", ref: "e2" } }, thoughtSignature: "sig123" },
    ]);
    expect(toGeminiParts([
      { type: "tool_call", name: "browser_act", args: {} },
    ])).toEqual([
      { functionCall: { name: "browser_act", args: {} }, thoughtSignature: "skip_thought_signature_validator" },
    ]);
    expect(toGeminiParts([
      { type: "tool_result", name: "browser_act", result: '{"tabId":3}' },
    ])).toEqual([
      { functionResponse: { name: "browser_act", response: { result: '{"tabId":3}' } } },
    ]);
  });

  test("tool-result messages take the SDK 'function' role required by history validation", () => {
    expect(toGeminiMessage({
      role: "user",
      content: [{ type: "tool_result", name: "echo", result: "ok" }],
      timestamp: 1,
    })).toEqual({
      role: "function",
      parts: [{ functionResponse: { name: "echo", response: { result: "ok" } } }],
    });
    expect(toGeminiMessage({
      role: "model",
      content: [{ type: "tool_call", name: "echo", args: {}, thoughtSignature: "sig" }],
      timestamp: 1,
    })).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "echo", args: {} }, thoughtSignature: "sig" }],
    });
  });

  test("text-only consumers render tool exchanges descriptively, without bracket syntax", () => {
    const text = messageText({
      content: [
        { type: "tool_call", name: "echo", args: { a: 1 } },
        { type: "tool_result", name: "echo", result: "ok" },
      ],
    });
    expect(text).toContain("echo");
    expect(text).toContain("ok");
    expect(text).not.toContain("[tool_call:");
    expect(text).not.toContain("[tool_result:");
  });

  test("text-only consumers retain text and omit image bytes", () => {
    expect(messageText({
      content: [
        { type: "text", text: "capture note" },
        { type: "image", mimeType: "image/jpeg", base64: "secretbytes" },
      ],
    })).toBe("capture note");
  });

  test("Gemini tool schemas omit unsupported additionalProperties recursively", () => {
    expect(toGeminiFunctionParameters({
      type: "object",
      additionalProperties: false,
      properties: {
        nested: {
          type: "object",
          additionalProperties: false,
          properties: { value: { type: "string" } },
        },
      },
    })).toEqual({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    });
  });
});
