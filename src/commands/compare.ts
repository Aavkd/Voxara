/**
 * compare command — Run a test suite against multiple models and render a side-by-side table.
 */

import React from "react";
import * as fs from "fs";
import { render } from "ink";
import { loadConfig } from "../config/loader";
import { createProvider } from "../providers/factory";
import { ILLMProvider } from "../providers/ILLMProvider";
import { CompareTable } from "../display";
import {
  TestSuite,
  TestCase,
  TestCaseResult,
  PromptInput,
  AppConfig,
} from "../types";

export async function compareCommand(
  filePath: string,
  options: { key?: string; models: string }
): Promise<void> {
  // Parse and validate the models list
  const modelList = options.models
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  if (modelList.length < 2) {
    console.error(
      `Error: --models requires at least 2 comma-separated model names (got ${modelList.length}).`
    );
    process.exit(1);
    return;
  }

  const config = loadConfig({ apiKey: options.key });

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    console.error(`Error: Invalid JSON in "${filePath}".`);
    process.exit(1);
    return;
  }

  // Reject agentic/rag suite types
  if (parsed.type === "agentic" || parsed.type === "rag" || parsed.type === "conversation") {
    console.error(
      `Error: compare only works on standard benchmark suites. ` +
        `Got type "${parsed.type}" — use the dedicated command instead.`
    );
    process.exit(1);
    return;
  }

  const suite = parsed as TestSuite;

  if (!suite.tests || !Array.isArray(suite.tests)) {
    console.error(`Error: Test suite must contain a "tests" array.`);
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
    if (!t.prompt) {
      console.error(`Error: Test "${t.id}" is missing required "prompt" field.`);
      process.exit(1);
      return;
    }
  }

  const suiteName = suite.name || filePath;
  const total = suite.tests.length;

  console.log(
    `\n🧪 Comparing ${modelList.length} models on: ${suiteName} (${total} tests)\n`
  );
  console.log(`   Models: ${modelList.join(", ")}\n`);

  // Run all models in parallel
  const allModelResults = await Promise.all(
    modelList.map((modelName) =>
      runSuiteForModel(suite, config, modelName)
    )
  );

  // Collect results into a Map
  const resultMap = new Map<string, TestCaseResult[]>();
  for (let i = 0; i < modelList.length; i++) {
    resultMap.set(modelList[i], allModelResults[i]);
  }

  // Render comparison table
  const { waitUntilExit } = render(
    React.createElement(CompareTable, { models: modelList, results: resultMap })
  );
  await waitUntilExit();

  // Exit code: 0 only if every model passed every test
  const allPassed = allModelResults.every((modelResults) =>
    modelResults.every((r) => r.passed)
  );
  process.exit(allPassed ? 0 : 1);
}

/**
 * Run all tests in the suite sequentially for a single model.
 * Performs keyword and latency checks only.
 */
async function runSuiteForModel(
  suite: TestSuite,
  config: AppConfig,
  modelName: string
): Promise<TestCaseResult[]> {
  const modelConfig = { ...config, model: modelName };
  const provider = createProvider(modelConfig);
  const results: TestCaseResult[] = [];

  for (const testCase of suite.tests) {
    const result = await runTestForModel(provider, testCase, suite, modelName);
    results.push(result);
  }

  return results;
}

/**
 * Run a single test case for a given model provider.
 */
async function runTestForModel(
  provider: ILLMProvider,
  testCase: TestCase,
  suite: TestSuite,
  modelName: string
): Promise<TestCaseResult> {
  const input: PromptInput = {
    prompt: testCase.prompt,
    model: modelName,
    temperature: suite.defaults?.temperature,
    maxTokens: suite.defaults?.maxTokens,
    systemPrompt: testCase.systemPrompt || suite.defaults?.systemPrompt,
  };

  try {
    const result = await provider.prompt(input);

    const matchedKeywords: string[] = [];
    const missedKeywords: string[] = [];

    if (testCase.expect?.keywords) {
      const responseLC = result.text.toLowerCase();
      for (const kw of testCase.expect.keywords) {
        if (responseLC.includes(kw.toLowerCase())) {
          matchedKeywords.push(kw);
        } else {
          missedKeywords.push(kw);
        }
      }
    }

    let latencyPassed = true;
    let error: string | undefined;
    if (
      testCase.expect?.maxLatencyMs !== undefined &&
      result.latencyMs > testCase.expect.maxLatencyMs
    ) {
      latencyPassed = false;
      error = `Latency ${result.latencyMs}ms exceeded max ${testCase.expect.maxLatencyMs}ms`;
    }

    const passed = missedKeywords.length === 0 && latencyPassed;

    return {
      id: testCase.id,
      passed,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      matchedKeywords,
      missedKeywords,
      error,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: testCase.id,
      passed: false,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      matchedKeywords: [],
      missedKeywords: testCase.expect?.keywords ?? [],
      error: msg,
    };
  }
}
