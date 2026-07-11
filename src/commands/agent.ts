/**
 * agent command — Run an agentic test suite with tool-use assertions.
 *
 * Phase C.6 (E1: Agentic Testing)
 */

import React from "react";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { render } from "ink";
import { loadConfig } from "../config/loader";
import { createProvider } from "../providers/factory";
import { getTools } from "../providers/tools/index";
import { runAgentLoop } from "../engine/agentLoop";
import AgentTrace from "../display/components/AgentTrace";
import AgentResult from "../display/components/AgentResult";
import {
  AgentTestSuite,
  AgentTestCase,
  AgentTestCaseResult,
  AgentStepResult,
  ToolCallRecord,
  ToolCallExpectation,
} from "../types";

export async function agentCommand(
  filePath: string,
  options: { key?: string; model?: string; maxSteps?: string }
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
  

  let suite: AgentTestSuite;
  try {
    suite = JSON.parse(rawContent) as AgentTestSuite;
  } catch {
    console.error(`Error: Invalid JSON in "${filePath}".`);
    process.exit(1);
    return;
  }

  // Validate suite structure
  if (suite.type !== "agentic") {
    console.error(
      `Error: Suite type must be "agentic", got "${suite.type}".`
    );
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
    if (!t.prompt) {
      console.error(`Error: Test "${t.id}" is missing required "prompt" field.`);
      process.exit(1);
      return;
    }
  }

  // Resolve maxSteps: CLI option → suite defaults → hardcoded default of 10
  const maxSteps =
    options.maxSteps !== undefined
      ? parseInt(options.maxSteps, 10)
      : (suite.defaults?.maxSteps ?? 10);

  // Resolve tools — fail fast on unknown names
  let tools;
  try {
    tools = getTools(suite.tools ?? []);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
    return;
  }

  // Resolve sandbox directory
  const autoSandbox = suite.sandbox === undefined;
  const sandboxDir = suite.sandbox
    ? path.resolve(path.dirname(filePath), suite.sandbox)
    : path.join(process.cwd(), `llmtest-sandbox-${Date.now()}`);

  if (!fs.existsSync(sandboxDir)) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  const provider = createProvider(config);
  const results: AgentTestCaseResult[] = [];
  const total = suite.tests.length;
  const suiteName = suite.name || filePath;

  console.log(`\n🤖 Running agent suite: ${suiteName} (${total} tests)\n`);
  console.log(`   Sandbox: ${sandboxDir}`);
  console.log(`   Tools:   ${tools.map((t) => t.name).join(", ") || "(none)"}`);
  console.log(`   maxSteps: ${maxSteps}\n`);

  for (let i = 0; i < total; i++) {
    const testCase = suite.tests[i];
    const steps: AgentStepResult[] = [];

    console.log(`▶ [${i + 1}/${total}] ${testCase.id}`);

    // Live trace renderer
    let traceUnmount: (() => void) | undefined;

    const startTrace = () => {
      const { unmount } = render(
        React.createElement(AgentTrace, {
          steps,
          isLoading: true,
        })
      );
      traceUnmount = unmount;
    };

    startTrace();

    const onStep = (step: AgentStepResult) => {
      steps.push(step);
      // Re-render the trace with updated steps
      traceUnmount?.();
      const { unmount } = render(
        React.createElement(AgentTrace, {
          steps,
          isLoading: step.type !== "final_answer",
        })
      );
      traceUnmount = unmount;
    };

    const caseMaxSteps = testCase.expect?.maxSteps ?? maxSteps;
    const loopResult = await runAgentLoop(
      provider,
      tools,
      testCase.prompt,
      sandboxDir,
      caseMaxSteps,
      onStep
    );

    // Unmount the live trace
    traceUnmount?.();

    // Render the final trace with the complete answer
    const { waitUntilExit } = render(
      React.createElement(AgentTrace, {
        steps,
        finalAnswer: loopResult.finalAnswer,
        isLoading: false,
      })
    );
    await waitUntilExit();

    // ── Run assertions ──────────────────────────────────────────────

    // Tool call assertions
    const matchedToolCalls: string[] = [];
    const missedToolCalls: string[] = [];

    if (testCase.expect?.toolCalls) {
      for (const expected of testCase.expect.toolCalls) {
        if (toolCallSatisfied(expected, loopResult.toolCallsMade)) {
          matchedToolCalls.push(expected.name);
        } else {
          missedToolCalls.push(expected.name);
        }
      }
    }

    // Keyword assertions against final answer
    const matchedKeywords: string[] = [];
    const missedKeywords: string[] = [];

    if (testCase.expect?.keywords) {
      const answerLC = loopResult.finalAnswer.toLowerCase();
      for (const kw of testCase.expect.keywords) {
        if (answerLC.includes(kw.toLowerCase())) {
          matchedKeywords.push(kw);
        } else {
          missedKeywords.push(kw);
        }
      }
    }

    // File assertions
    const fileAssertionResults: { path: string; passed: boolean }[] = [];

    if (testCase.expect?.fileAssertions) {
      for (const fa of testCase.expect.fileAssertions) {
        const fullPath = path.join(sandboxDir, fa.path);
        let passed = false;
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          passed = content.includes(fa.contains);
        } catch {
          passed = false;
        }
        fileAssertionResults.push({ path: fa.path, passed });
      }
    }

    const allPassed =
      missedToolCalls.length === 0 &&
      missedKeywords.length === 0 &&
      fileAssertionResults.every((f) => f.passed) &&
      !loopResult.error;

    const result: AgentTestCaseResult = {
      id: testCase.id,
      passed: allPassed,
      steps: loopResult.steps,
      toolCallsMade: loopResult.toolCallsMade,
      matchedToolCalls,
      missedToolCalls,
      fileAssertionResults,
      matchedKeywords,
      missedKeywords,
      finalAnswer: loopResult.finalAnswer,
      error: loopResult.error,
    };

    results.push(result);
  }

  // Clean up auto-created sandbox
  if (autoSandbox && fs.existsSync(sandboxDir)) {
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {
      // Non-fatal: leave the directory if cleanup fails
    }
  }

  // Render results table
  const { waitUntilExit } = render(
    React.createElement(AgentResult, { results, suiteName })
  );
  await waitUntilExit();

  const passed = results.filter((r) => r.passed).length;
  process.exit(passed === total ? 0 : 1);
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Check whether an expected tool call is satisfied by the recorded tool calls.
 * Name match is required; params subset match is checked only when params are specified.
 */
function toolCallSatisfied(
  expected: ToolCallExpectation,
  made: ToolCallRecord[]
): boolean {
  return made.some((record) => {
    if (record.name !== expected.name) return false;

    // If no params expected, name match alone is sufficient
    if (!expected.params) return true;

    // Subset check: every key in expected.params must match the recorded params
    return Object.entries(expected.params).every(
      ([k, v]) => JSON.stringify(record.params[k]) === JSON.stringify(v)
    );
  });
}
