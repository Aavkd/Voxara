/**
 * convo command — Run a multi-turn conversation test suite from a JSON file.
 *
 * Phase G.2 (E5: Multi-turn Conversation Testing)
 */

import React from "react";
import * as fs from "fs";
import { render } from "ink";
import { loadConfig } from "../config/loader";
import { createProvider } from "../providers/factory";
import { ILLMProvider } from "../providers/ILLMProvider";
import ConvoResult from "../display/components/ConvoResult";
import {
  ConversationTestSuite,
  ConversationTestCase,
  ConversationTestCaseResult,
  ConversationTurnResult,
  Message,
  messageText,
} from "../types";

export async function convoCommand(
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    console.error(`Error: Invalid JSON in "${filePath}".`);
    process.exit(1);
    return;
  }

  // Validate suite type
  if (parsed.type !== "conversation") {
    console.error(
      `Error: Expected suite type "conversation", got "${parsed.type ?? "undefined"}". ` +
        `Use the appropriate command for other suite types.`
    );
    process.exit(1);
    return;
  }

  const suite = parsed as ConversationTestSuite;

  if (!suite.tests || !Array.isArray(suite.tests)) {
    console.error(`Error: Test suite must contain a "tests" array.`);
    process.exit(1);
    return;
  }

  // Validate each test case
  for (let i = 0; i < suite.tests.length; i++) {
    const t = suite.tests[i];
    if (!t.id) {
      console.error(`Error: Test at index ${i} is missing required "id" field.`);
      process.exit(1);
      return;
    }
    if (!Array.isArray(t.turns) || t.turns.length === 0) {
      console.error(
        `Error: Test "${t.id}" must have a non-empty "turns" array.`
      );
      process.exit(1);
      return;
    }
    for (let j = 0; j < t.turns.length; j++) {
      if (!t.turns[j].user) {
        console.error(
          `Error: Test "${t.id}", turn ${j} is missing required "user" field.`
        );
        process.exit(1);
        return;
      }
    }
  }

  const provider = createProvider(config);
  const results: ConversationTestCaseResult[] = [];
  const suiteName = suite.name || filePath;

  console.log(
    `\n💬 Running conversation suite: ${suiteName} (${suite.tests.length} tests)\n`
  );

  const ora = await import("ora");

  for (const test of suite.tests) {
    const result = await runConversationTest(provider, test, ora.default);
    results.push(result);

    if (result.passed) {
      console.log(`  ✅ ${test.id} — passed`);
    } else {
      console.log(`  ❌ ${test.id} — failed`);
    }
  }

  // Render results
  const { waitUntilExit } = render(
    React.createElement(ConvoResult, { results, suiteName })
  );
  await waitUntilExit();

  const passed = results.filter((r) => r.passed).length;
  process.exit(passed === results.length ? 0 : 1);
}

/**
 * Run all turns of a single conversation test case.
 * Stops on the first failing turn; remaining turns are marked as skipped.
 */
async function runConversationTest(
  provider: ILLMProvider,
  test: ConversationTestCase,
  oraFn: (text: string) => { start: () => { stop: () => void } }
): Promise<ConversationTestCaseResult> {
  const messages: Message[] = [];
  const turnResults: ConversationTurnResult[] = [];
  const totalTurns = test.turns.length;
  let failed = false;

  for (let i = 0; i < totalTurns; i++) {
    const turn = test.turns[i];

    // If a previous turn already failed, mark this turn as skipped
    if (failed) {
      turnResults.push({
        turnIndex: i,
        passed: false,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        matchedKeywords: [],
        missedKeywords: turn.expect?.keywords ?? [],
        response: "",
      });
      continue;
    }

    // Append the user message and call the provider
    messages.push({ role: "user", content: turn.user, timestamp: Date.now() });

    const spinner = oraFn(`Turn ${i + 1}/${totalTurns} for ${test.id}…`).start();
    let chatResult;
    try {
      chatResult = await provider.chat(messages);
    } catch (err: unknown) {
      spinner.stop();
      const errMsg = err instanceof Error ? err.message : String(err);
      // Mark this and all remaining turns as skipped
      failed = true;
      turnResults.push({
        turnIndex: i,
        passed: false,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        matchedKeywords: [],
        missedKeywords: turn.expect?.keywords ?? [],
        response: "",
      });
      return {
        id: test.id,
        passed: false,
        turns: [
          ...turnResults,
          ...test.turns.slice(i + 1).map((t, offset) => ({
            turnIndex: i + 1 + offset,
            passed: false,
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            matchedKeywords: [],
            missedKeywords: t.expect?.keywords ?? [],
            response: "",
          })),
        ],
        error: `Turn ${i + 1} error: ${errMsg}`,
      };
    }
    spinner.stop();

    // Append the model response to the conversation history
    messages.push(chatResult.message);

    const responseText = messageText(chatResult.message);

    // Keyword assertions (case-insensitive)
    const matchedKeywords: string[] = [];
    const missedKeywords: string[] = [];
    if (turn.expect?.keywords) {
      const responseLC = responseText.toLowerCase();
      for (const kw of turn.expect.keywords) {
        if (responseLC.includes(kw.toLowerCase())) {
          matchedKeywords.push(kw);
        } else {
          missedKeywords.push(kw);
        }
      }
    }

    // Latency assertion
    let latencyPassed = true;
    if (
      turn.expect?.maxLatencyMs !== undefined &&
      chatResult.latencyMs > turn.expect.maxLatencyMs
    ) {
      latencyPassed = false;
    }

    const turnPassed = missedKeywords.length === 0 && latencyPassed;

    turnResults.push({
      turnIndex: i,
      passed: turnPassed,
      latencyMs: chatResult.latencyMs,
      inputTokens: chatResult.inputTokens,
      outputTokens: chatResult.outputTokens,
      matchedKeywords,
      missedKeywords,
      response: responseText,
    });

    if (!turnPassed) {
      failed = true;
    }
  }

  const allPassed = turnResults.every((t) => t.passed);

  return {
    id: test.id,
    passed: allPassed,
    turns: turnResults,
  };
}
