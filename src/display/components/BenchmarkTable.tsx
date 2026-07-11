/**
 * BenchmarkTable — Renders a table of TestCaseResult[] with aligned columns.
 *
 * Columns: ID | Pass/Fail | Latency | Tokens | Keywords | [Judge Score]
 * The Judge Score column is only rendered when at least one result has a judgeResult.
 */

import React from "react";
import { Box, Text } from "ink";
import { TestCaseResult } from "../../types";
import JudgeScore from "./JudgeScore";

interface BenchmarkTableProps {
  results: TestCaseResult[];
}

const BenchmarkTable: React.FC<BenchmarkTableProps> = ({ results }) => {
  const hasJudge = results.some((r) => r.judgeResult !== undefined);

  // Calculate column widths for alignment
  const idWidth = Math.max(4, ...results.map((r) => r.id.length));
  const latencyWidth = Math.max(
    7,
    ...results.map((r) => `${r.latencyMs}ms`.length)
  );
  const tokensWidth = Math.max(
    6,
    ...results.map((r) => `${r.inputTokens + r.outputTokens}`.length)
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header */}
      <Box>
        <Text bold>
          {pad("ID", idWidth)} │ Result │ {pad("Latency", latencyWidth)} │{" "}
          {pad("Tokens", tokensWidth)} │ Keywords
          {hasJudge ? " │ Judge" : ""}
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          {"─".repeat(idWidth)}─┼────────┼─{"─".repeat(latencyWidth)}─┼─
          {"─".repeat(tokensWidth)}─┼─{"─".repeat(20)}
          {hasJudge ? "─┼─────────────" : ""}
        </Text>
      </Box>

      {/* Rows */}
      {results.map((r) => (
        <Box key={r.id} flexDirection="column">
          <Box>
            <Text>
              {pad(r.id, idWidth)} │{" "}
              {r.passed ? (
                <Text color="green"> ✅   </Text>
              ) : (
                <Text color="red"> ❌   </Text>
              )}{" "}
              │ {pad(`${r.latencyMs}ms`, latencyWidth)} │{" "}
              {pad(`${r.inputTokens + r.outputTokens}`, tokensWidth)} │{" "}
              {formatKeywords(r)}
            </Text>
          </Box>
          {/* Inline judge score row, only when present */}
          {r.judgeResult && (
            <JudgeScore
              result={r.judgeResult}
              criteria={r.judgeResult.reason}
            />
          )}
        </Box>
      ))}
    </Box>
  );
};

function pad(str: string, len: number): string {
  if (str.length >= len) return str;
  return str + " ".repeat(len - str.length);
}

function formatKeywords(r: TestCaseResult): string {
  const parts: string[] = [];

  if (r.matchedKeywords.length > 0) {
    parts.push(`✓ ${r.matchedKeywords.join(", ")}`);
  }
  if (r.missedKeywords.length > 0) {
    parts.push(`✗ ${r.missedKeywords.join(", ")}`);
  }
  if (r.error) {
    parts.push(`⚠ ${r.error}`);
  }
  if (parts.length === 0) {
    return "—";
  }

  return parts.join(" | ");
}

export default BenchmarkTable;
