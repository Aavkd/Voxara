import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  extractPromptVariables,
  interpolatePrompt,
  renderPrompt,
  validatePrompts,
} from "../src/prompts/promptLoader";
import { buildContextPrompt } from "../src/rag/contextBuilder";

describe("promptLoader", () => {
  const originalPromptsDir = process.env.PROMPTS_DIR;

  afterEach(() => {
    if (originalPromptsDir === undefined) {
      delete process.env.PROMPTS_DIR;
    } else {
      process.env.PROMPTS_DIR = originalPromptsDir;
    }
  });

  it("extracts and interpolates template variables", () => {
    expect(extractPromptVariables("Hello {{name}} from {{ place }}")).toEqual([
      "name",
      "place",
    ]);

    expect(
      interpolatePrompt("Hello {{name}} from {{ place }}", {
        name: "Ada",
        place: "Paris",
      })
    ).toBe("Hello Ada from Paris");
  });

  it("fails unknown variables in debug mode", () => {
    expect(() =>
      interpolatePrompt("Hello {{name}}", {}, { debug: true })
    ).toThrow("unknown variable");
  });

  it("validates the default prompt directory", () => {
    const result = validatePrompts();
    expect(result.ok).toBe(true);
    expect(result.checked).toHaveLength(10);
    expect(result.errors).toEqual([]);
  });

  it("renders prompt files at runtime through PROMPTS_DIR", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmtest-prompts-"));
    fs.writeFileSync(
      path.join(tempDir, "rag.md"),
      "Docs:\n{{documents}}\nQuestion={{question}}\nSystem={{systemPrompt}}",
      "utf-8"
    );
    process.env.PROMPTS_DIR = tempDir;

    expect(
      renderPrompt("rag", {
        documents: "source text",
        question: "What changed?",
        systemPrompt: "Answer from docs.",
      })
    ).toContain("Question=What changed?");

    expect(buildContextPrompt(["alpha"], "What is here?")).toContain(
      "Question=What is here?"
    );
  });
});
