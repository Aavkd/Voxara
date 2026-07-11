/**
 * rag command — Run a RAG (Retrieval-Augmented Generation) test suite.
 *
 * Phase D.5 (E2: RAG Testing)
 */

import React from "react";
import * as fs from "fs";
import * as path from "path";
import { render } from "ink";
import { loadConfig } from "../config/loader";
import { createProvider } from "../providers/factory";
import { loadDocuments } from "../rag/documentLoader";
import { buildContextPrompt } from "../rag/contextBuilder";
import { runFaithfulnessJudge } from "../rag/faithfulnessJudge";
import RagResult from "../display/components/RagResult";
import { ILLMProvider } from "../providers/ILLMProvider";
import {
  RagTestSuite,
  RagTestCase,
  RagTestCaseResult,
  FaithfulnessScore,
} from "../types";

export async function ragCommand(
  filePath: string,
  options: { key?: string; model?: string; judgeModel?: string }
): Promise<void> {
  const config = loadConfig({ apiKey: options.key, model: options.model });

  // Read and parse the suite file
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Cannot read file "${filePath}": ${msg}`);
    process.exit(1);
    return;
  }

  let suite: RagTestSuite;
  try {
    suite = JSON.parse(rawContent) as RagTestSuite;
  } catch {
    console.error(`Error: Invalid JSON in "${filePath}".`);
    process.exit(1);
    return;
  }

  // Validate suite structure
  if (suite.type !== "rag") {
    console.error(`Error: Suite type must be "rag", got "${suite.type}".`);
    process.exit(1);
    return;
  }
  if (!Array.isArray(suite.tests) || suite.tests.length === 0) {
    console.error(`Error: Suite must contain a non-empty "tests" array.`);
    process.exit(1);
    return;
  }
  for (let i = 0; i < suite.tests.length; i++) {
    const t = suite.tests[i];
    if (!t.id) {
      console.error(`Error: Test at index ${i} is missing required "id" field.`);
      process.exit(1);
      return;
    }
    if (!t.question) {
      console.error(`Error: Test "${t.id}" is missing required "question" field.`);
      process.exit(1);
      return;
    }
    if (!Array.isArray(t.documents) || t.documents.length === 0) {
      console.error(`Error: Test "${t.id}" must have a non-empty "documents" array.`);
      process.exit(1);
      return;
    }
  }

  const provider = createProvider(config);
  const suiteModel = suite.model ?? config.model;
  const judgeModel = options.judgeModel;
  const baseDir = path.dirname(path.resolve(filePath));
  const total = suite.tests.length;
  const suiteName = suite.name || filePath;
  const results: RagTestCaseResult[] = [];

  console.log(`\n📚 Running RAG suite: ${suiteName} (${total} tests)\n`);

  for (let i = 0; i < total; i++) {
    const testCase = suite.tests[i];
    process.stdout.write(`  Testing ${testCase.id} (${i + 1}/${total})… `);

    const result = await runRagTestCase(
      provider,
      testCase,
      suiteModel,
      judgeModel,
      baseDir
    );

    process.stdout.write(result.passed ? "✅\n" : "❌\n");
    results.push(result);
  }

  console.log();

  const { waitUntilExit } = render(
    React.createElement(RagResult, { results, suiteName })
  );
  await waitUntilExit();

  const passed = results.filter((r) => r.passed).length;
  process.exit(passed === total ? 0 : 1);
}

// ── Core test runner ──────────────────────────────────────────────

async function runRagTestCase(
  provider: ILLMProvider,
  testCase: RagTestCase,
  model: string,
  judgeModel: string | undefined,
  baseDir: string
): Promise<RagTestCaseResult> {
  // Load documents
  let docs: string[];
  try {
    docs = await loadDocuments(testCase.documents, baseDir);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeErrorResult(testCase.id, msg);
  }

  // Build context prompt
  const contextPrompt = buildContextPrompt(
    docs,
    testCase.question,
    testCase.systemPrompt
  );

  // Run the prompt
  let responseText: string;
  let latencyMs: number;
  let inputTokens: number;
  let outputTokens: number;

  try {
    const startMs = Date.now();
    const promptResult = await provider.prompt({ prompt: contextPrompt, model });
    latencyMs = Date.now() - startMs;
    responseText = promptResult.text;
    inputTokens = promptResult.inputTokens;
    outputTokens = promptResult.outputTokens;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeErrorResult(testCase.id, `Provider error: ${msg}`);
  }

  // ── Assertions ───────────────────────────────────────────────────

  const expect = testCase.expect;

  // Keyword assertions (case-insensitive substring)
  const matchedKeywords: string[] = [];
  const missedKeywords: string[] = [];
  if (expect?.keywords) {
    const responseLower = responseText.toLowerCase();
    for (const kw of expect.keywords) {
      if (responseLower.includes(kw.toLowerCase())) {
        matchedKeywords.push(kw);
      } else {
        missedKeywords.push(kw);
      }
    }
  }

  // Quote assertions: quote must exist in source docs AND in the response
  const matchedQuotes: string[] = [];
  const missedQuotes: string[] = [];
  if (expect?.quotes) {
    const combinedDocs = docs.join("\n");
    for (const quote of expect.quotes) {
      const inDocs = combinedDocs.includes(quote);
      const inResponse = responseText.includes(quote);
      if (inDocs && inResponse) {
        matchedQuotes.push(quote);
      } else {
        missedQuotes.push(quote);
        if (!inDocs) {
          console.warn(
            `  ⚠ Quote not found in source documents: "${quote.slice(0, 60)}…"`
          );
        }
      }
    }
  }

  // Faithfulness assertion
  let faithfulness: FaithfulnessScore | undefined;
  let faithnessFailed = false;
  let noHallucinationFailed = false;

  if (expect?.noHallucination && !expect?.faithfulness) {
    console.warn(
      `  ⚠ Test "${testCase.id}": noHallucination requires faithfulness: true — skipping noHallucination check.`
    );
  }

  if (expect?.faithfulness) {
    const threshold = expect.faithfulnessThreshold ?? 0.7;
    try {
      faithfulness = await runFaithfulnessJudge(
        provider,
        testCase.question,
        docs,
        responseText,
        { model: judgeModel, noHallucination: expect.noHallucination ?? false, threshold }
      );
      if (faithfulness.score < threshold) {
        faithnessFailed = true;
      }
      if (expect.noHallucination && faithfulness.hallucinated) {
        noHallucinationFailed = true;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠ Faithfulness judge error for "${testCase.id}": ${msg}`);
    }
  }

  const passed =
    missedKeywords.length === 0 &&
    missedQuotes.length === 0 &&
    !faithnessFailed &&
    !noHallucinationFailed;

  return {
    id: testCase.id,
    passed,
    latencyMs,
    inputTokens,
    outputTokens,
    matchedKeywords,
    missedKeywords,
    matchedQuotes,
    missedQuotes,
    faithfulness,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function makeErrorResult(id: string, error: string): RagTestCaseResult {
  return {
    id,
    passed: false,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    matchedKeywords: [],
    missedKeywords: [],
    matchedQuotes: [],
    missedQuotes: [],
    error,
  };
}
