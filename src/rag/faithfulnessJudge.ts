/**
 * Faithfulness Judge — evaluates whether a RAG response is grounded in source documents.
 *
 * Phase D.3 (E2: RAG Testing)
 */

import { ILLMProvider } from "../providers/ILLMProvider";
import { renderPrompt } from "../prompts/promptLoader";
import { FaithfulnessScore } from "../types";

const FALLBACK: FaithfulnessScore = {
  score: 0,
  reason: "Judge parse error",
  hallucinated: true,
};

/**
 * Run a faithfulness evaluation using an LLM judge.
 *
 * @param provider  - The LLM provider used for the judge call.
 * @param question  - The original question asked.
 * @param documents - The source documents used to answer the question.
 * @param response  - The model's response to evaluate.
 * @param config    - Judge configuration (model override, noHallucination flag, threshold).
 * @returns         - A `FaithfulnessScore` with a 0.0–1.0 score, reason, and hallucination flag.
 */
export async function runFaithfulnessJudge(
  provider: ILLMProvider,
  question: string,
  documents: string[],
  response: string,
  config: {
    model?: string;
    noHallucination: boolean;
    threshold: number;
  }
): Promise<FaithfulnessScore> {
  const judgePrompt = buildFaithfulnessPrompt(question, documents, response);

  try {
    const result = await provider.prompt({
      prompt: judgePrompt,
      model: config.model,
      temperature: 0,
    });

    return parseFaithfulnessResponse(result.text) ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}

// ── Private Helpers ───────────────────────────────────────────────

/**
 * Build the faithfulness judge prompt.
 */
function buildFaithfulnessPrompt(
  question: string,
  documents: string[],
  response: string
): string {
  const docBlock = documents
    .map((d, i) => `--- Document ${i + 1} ---\n${d.trim()}`)
    .join("\n\n");

  return renderPrompt("faithfulness", {
    documents: docBlock,
    question,
    response,
  });
}

/**
 * Parse the faithfulness judge's JSON response.
 * Returns null if parsing or validation fails.
 */
function parseFaithfulnessResponse(text: string): FaithfulnessScore | null {
  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    if (
      typeof parsed.score !== "number" ||
      typeof parsed.reason !== "string" ||
      typeof parsed.hallucinated !== "boolean"
    ) {
      return null;
    }

    const score = Math.min(1, Math.max(0, parsed.score));

    return {
      score,
      reason: parsed.reason,
      hallucinated: parsed.hallucinated,
    };
  } catch {
    return null;
  }
}
