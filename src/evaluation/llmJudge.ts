/**
 * LLM Judge Engine — evaluates a model response against a scoring criterion
 * using another LLM call as an impartial judge.
 *
 * Phase B.1 (E6: LLM-as-Judge)
 */

import { ILLMProvider } from "../providers/ILLMProvider";
import { renderPrompt } from "../prompts/promptLoader";
import { JudgeCriteria, JudgeResult } from "../types";

/**
 * Run an LLM-as-Judge evaluation.
 *
 * @param provider - The LLM provider used to call the judge model.
 * @param input    - The original prompt, the model response, and judge criteria.
 * @returns        - A `JudgeResult` with score, reason, and pass/fail flag.
 */
export async function runJudge(
  provider: ILLMProvider,
  input: {
    prompt: string;
    response: string;
    criteria: JudgeCriteria;
  }
): Promise<JudgeResult> {
  const { prompt, response, criteria } = input;

  const judgePrompt = buildJudgePrompt(prompt, response, criteria.criteria);

  const judgeResult = await callJudge(provider, judgePrompt, criteria.model);
  if (judgeResult !== null) {
    return {
      score: judgeResult.score,
      reason: judgeResult.reason,
      passed: judgeResult.score >= criteria.minScore,
    };
  }

  // First attempt failed — retry with a stricter prompt
  const strictPrompt = buildStrictJudgePrompt(prompt, response, criteria.criteria);
  const retryResult = await callJudge(provider, strictPrompt, criteria.model);
  if (retryResult !== null) {
    return {
      score: retryResult.score,
      reason: retryResult.reason,
      passed: retryResult.score >= criteria.minScore,
    };
  }

  // Both attempts failed — return a safe fallback
  return {
    score: 0,
    reason: "Judge parse error",
    passed: false,
  };
}

// ── Private Helpers ───────────────────────────────────────────────

/**
 * Attempt a single judge call and parse its JSON response.
 * Returns null if parsing fails.
 */
async function callJudge(
  provider: ILLMProvider,
  judgePrompt: string,
  model?: string
): Promise<{ score: number; reason: string } | null> {
  try {
    const result = await provider.prompt({
      prompt: judgePrompt,
      model,
      temperature: 0,
    });

    return parseJudgeResponse(result.text);
  } catch {
    return null;
  }
}

/**
 * Parse the judge's JSON response.
 * Accepts the raw text and attempts to extract the JSON object.
 * Returns null on any parse or validation failure.
 */
function parseJudgeResponse(
  text: string
): { score: number; reason: string } | null {
  try {
    // Strip markdown code fences if the model wrapped the JSON
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    if (
      typeof parsed.score !== "number" ||
      typeof parsed.reason !== "string"
    ) {
      return null;
    }

    const score = Math.round(parsed.score);
    if (score < 0 || score > 10) {
      return null;
    }

    return { score, reason: parsed.reason };
  } catch {
    return null;
  }
}

/**
 * Build the standard judge prompt.
 */
function buildJudgePrompt(
  originalPrompt: string,
  modelResponse: string,
  criteria: string
): string {
  return renderPrompt("judge", {
    criteria,
    originalPrompt,
    modelResponse,
  });
}

/**
 * Build a stricter judge prompt used in the retry attempt.
 */
function buildStrictJudgePrompt(
  originalPrompt: string,
  modelResponse: string,
  criteria: string
): string {
  return renderPrompt("judge-strict", {
    criteria,
    originalPrompt,
    modelResponse,
  });
}
