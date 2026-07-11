/**
 * ConvoResult — Table of ConversationTestCaseResult[] with per-turn detail.
 *
 * Phase G.1 (E5: Multi-turn Conversation Testing)
 *
 * Summary row per test: id | pass/fail | turns passed | total tokens
 * Detail rows per turn: index | user message (truncated) | pass/fail | latency | keywords
 */

import React from "react";
import { Box, Text } from "ink";
import {
  ConversationTestCaseResult,
  ConversationTurnResult,
} from "../../types";

interface ConvoResultProps {
  results: ConversationTestCaseResult[];
  suiteName?: string;
}

const ConvoResult: React.FC<ConvoResultProps> = ({ results, suiteName }) => {
  const passed = results.filter((r) => r.passed).length;

  const idWidth = Math.max(4, ...results.map((r) => r.id.length));

  return (
    <Box flexDirection="column" marginTop={1}>
      {suiteName && (
        <Box marginBottom={1}>
          <Text bold>{"💬 "}</Text>
          <Text bold>{suiteName}</Text>
        </Box>
      )}

      {/* Header */}
      <Box>
        <Text bold>
          {pad("ID", idWidth)} │ Result │ Turns │ Tokens
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          {"─".repeat(idWidth)}─┼────────┼───────┼────────
        </Text>
      </Box>

      {/* Rows */}
      {results.map((r) => {
        const turnsPassed = r.turns.filter((t) => t.passed).length;
        const totalTokens = r.turns.reduce(
          (sum, t) => sum + t.inputTokens + t.outputTokens,
          0
        );

        return (
          <Box key={r.id} flexDirection="column">
            {/* Summary row */}
            <Box>
              <Text>
                {pad(r.id, idWidth)} │{" "}
                {r.passed ? (
                  <Text color="green">✅     </Text>
                ) : (
                  <Text color="red">❌     </Text>
                )}{" "}
                │ {pad(`${turnsPassed}/${r.turns.length}`, 5)} │ {totalTokens}
              </Text>
            </Box>

            {/* Error line */}
            {r.error && (
              <Box marginLeft={2}>
                <Text color="red">⚠ {r.error}</Text>
              </Box>
            )}

            {/* Per-turn detail */}
            {r.turns.map((turn) => (
              <TurnDetail key={turn.turnIndex} turn={turn} />
            ))}
          </Box>
        );
      })}

      {/* Summary */}
      <Box marginTop={1}>
        <Text>
          Passed:{" "}
          <Text color={passed === results.length ? "green" : "red"}>
            {passed}/{results.length}
          </Text>
        </Text>
      </Box>
    </Box>
  );
};

const TurnDetail: React.FC<{ turn: ConversationTurnResult }> = ({ turn }) => {
  const userPreview = turn.response === ""
    ? "(skipped)"
    : truncate(turn.response, 50);

  const kwSummary = formatKeywords(turn);

  return (
    <Box marginLeft={2} flexDirection="column">
      <Box>
        <Text dimColor>
          Turn {turn.turnIndex + 1}:{" "}
        </Text>
        {turn.passed ? (
          <Text color="green">✓ </Text>
        ) : (
          <Text color="red">✗ </Text>
        )}
        <Text>{pad(String(turn.latencyMs) + "ms", 8)} </Text>
        {kwSummary && <Text>{kwSummary} </Text>}
        <Text dimColor>{userPreview}</Text>
      </Box>

      {/* Missed keywords highlighted in red */}
      {turn.missedKeywords.length > 0 && (
        <Box marginLeft={4}>
          <Text color="red">
            ✗ Missing keywords: {turn.missedKeywords.join(", ")}
          </Text>
        </Box>
      )}
    </Box>
  );
};

function pad(str: string, len: number): string {
  if (str.length >= len) return str;
  return str + " ".repeat(len - str.length);
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function formatKeywords(turn: ConversationTurnResult): string {
  const parts: string[] = [];
  if (turn.matchedKeywords.length > 0) parts.push(`✓${turn.matchedKeywords.length}`);
  if (turn.missedKeywords.length > 0) parts.push(`✗${turn.missedKeywords.length}`);
  return parts.join(" ");
}

export default ConvoResult;
