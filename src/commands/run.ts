/**
 * run command — Run a benchmark test suite from a JSON file.
 */

import React from "react";
import * as fs from "fs";
import * as path from "path";
import { render } from "ink";
import { loadConfig } from "../config/loader";
import { createProvider } from "../providers/factory";
import { ILLMProvider } from "../providers/ILLMProvider";
import { BenchmarkTable } from "../display";
import { runJudge } from "../evaluation/llmJudge";
import {
  validateJsonSchema,
  evaluateJsonPath,
} from "../validation/jsonSchemaValidator";
import {
  TestSuite,
  TestCase,
  TestCaseResult,
  PromptInput,
  JudgeResult,
} from "../types";

export async function runCommand(
  filePath: string,
  options: { key?: string; model?: string }
): Promise<void> {
  const config = loadConfig({
    apiKey: options.key,
    model: options.model,
  });

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

  let suite: TestSuite;
  try {
    suite = JSON.parse(rawContent) as TestSuite;
  } catch (err: unknown) {
    console.error(`Error: Invalid JSON in "${filePath}".`);
    process.exit(1);
    return;
  }

  // Validate required fields
  if (!suite.tests || !Array.isArray(suite.tests)) {
    console.error(
      `Error: Test suite must contain a "tests" array.`
    );
    process.exit(1);
    return;
  }

  for (let i = 0; i < suite.tests.length; i++) {
    const t = suite.tests[i];
    if (!t.id) {
      console.error(
        `Error: Test at index ${i} is missing required "id" field.`
      );
      process.exit(1);
      return;
    }
    if (!t.prompt) {
      console.error(
        `Error: Test "${t.id}" is missing required "prompt" field.`
      );
      process.exit(1);
      return;
    }
  }

  const provider = createProvider(config);
  const results: TestCaseResult[] = [];
  const total = suite.tests.length;
  const suiteName = suite.name || filePath;

  console.log(`\n🧪 Running suite: ${suiteName} (${total} tests)\n`);

  const ora = await import("ora");

  for (let i = 0; i < total; i++) {
    const testCase = suite.tests[i];
    const spinner = ora
      .default(`Running ${testCase.id} (${i + 1}/${total})…`)
      .start();

    const result = await runSingleTest(
      provider,
      testCase,
      suite,
      config.model,
      filePath
    );
    results.push(result);

    if (result.passed) {
      spinner.succeed(`${testCase.id} — passed (${result.latencyMs}ms)`);
    } else {
      spinner.fail(
        `${testCase.id} — failed${result.error ? `: ${result.error}` : ""}`
      );
    }
  }

  // Render benchmark table
  const { waitUntilExit } = render(
    React.createElement(BenchmarkTable, { results })
  );
  await waitUntilExit();

  // Summary line
  const passed = results.filter((r) => r.passed).length;
  const avgLatency = Math.round(
    results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length
  );
  console.log(`\nPassed: ${passed}/${total} | Avg latency: ${avgLatency}ms\n`);

  process.exit(passed === total ? 0 : 1);
}

/**
 * Run a single test case, including LLM-as-Judge evaluation if configured.
 */
async function runSingleTest(
  provider: ILLMProvider,
  testCase: TestCase,
  suite: TestSuite,
  defaultModel: string,
  suiteFilePath: string
): Promise<TestCaseResult> {
  // Merge suite defaults with test case params
  const input: PromptInput = {
    prompt: testCase.prompt,
    model: suite.model || defaultModel,
    temperature: suite.defaults?.temperature,
    maxTokens: suite.defaults?.maxTokens,
    systemPrompt: testCase.systemPrompt || suite.defaults?.systemPrompt,
    // E4: pass JSON format fields through to the provider
    responseFormat: testCase.responseFormat,
    responseSchema: testCase.responseSchema,
    // E7: resolve image path relative to the suite file's directory
    image: testCase.image
      ? path.resolve(path.dirname(suiteFilePath), testCase.image)
      : undefined,
  };

  try {
    const result = await provider.prompt(input);

    // ── E4: Structured output validation ────────────────────────
    let parsedJson: unknown = undefined;
    const jsonErrors: string[] = [];

    if (testCase.responseFormat === "json") {
      try {
        parsedJson = JSON.parse(result.text);
      } catch {
        jsonErrors.push("Response was not valid JSON");
      }

      if (parsedJson !== undefined && testCase.responseSchema) {
        const schemaResult = validateJsonSchema(parsedJson, testCase.responseSchema);
        if (!schemaResult.valid) {
          jsonErrors.push(...schemaResult.errors);
        }
      }

      if (parsedJson !== undefined && testCase.expect?.jsonPath) {
        const pathResult = evaluateJsonPath(parsedJson, testCase.expect.jsonPath);
        if (!pathResult.passed) {
          jsonErrors.push(...pathResult.failures);
        }
      }
    }

    // Evaluate keyword check (case-insensitive)
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

    // Evaluate latency check
    let latencyPassed = true;
    if (
      testCase.expect?.maxLatencyMs !== undefined &&
      result.latencyMs > testCase.expect.maxLatencyMs
    ) {
      latencyPassed = false;
    }

    let error: string | undefined;
    if (!latencyPassed) {
      error = `Latency ${result.latencyMs}ms exceeded max ${testCase.expect!.maxLatencyMs}ms`;
    }

    // ── E6: LLM-as-Judge evaluation ──────────────────────────────
    let judgeResult: JudgeResult | undefined;
    let judgePassed = true;

    if (testCase.expect?.judge) {
      judgeResult = await runJudge(provider, {
        prompt: testCase.prompt,
        response: result.text,
        criteria: testCase.expect.judge,
      });
      if (!judgeResult.passed) {
        judgePassed = false;
        const judgeError = `Judge score ${judgeResult.score}/${testCase.expect.judge.minScore} — ${judgeResult.reason}`;
        error = error ? `${error}; ${judgeError}` : judgeError;
      }
    }

    // A test passes if keywords matched, latency is OK, judge passed, and JSON is valid
    const keywordsPassed = missedKeywords.length === 0;
    const jsonPassed = jsonErrors.length === 0;
    const passed = keywordsPassed && latencyPassed && judgePassed && jsonPassed;

    if (jsonErrors.length > 0) {
      const jsonErrStr = jsonErrors.join("; ");
      error = error ? `${error}; ${jsonErrStr}` : jsonErrStr;
    }

    return {
      id: testCase.id,
      passed,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      matchedKeywords,
      missedKeywords,
      error,
      judgeResult,
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
      missedKeywords: testCase.expect?.keywords || [],
      error: msg,
    };
  }
}
