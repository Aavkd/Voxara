import { toGeminiFunctionParameters, toGeminiParts } from "../src/providers/google";
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
