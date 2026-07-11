/**
 * RagResult — Table of RagTestCaseResult[] with faithfulness scores and summary.
 *
 * Phase D.4 (E2: RAG Testing)
 *
 * Columns: id | pass/fail | latency | keywords | quotes | faithfulness
 */

import React from "react";
import { Box, Text } from "ink";
import { RagTestCaseResult, FaithfulnessScore } from "../../types";

interface RagResultProps {
  results: RagTestCaseResult[];
  suiteName?: string;
}

const RagResult: React.FC<RagResultProps> = ({ results, suiteName }) => {
  const passed = results.filter((r) => r.passed).length;

  const idWidth = Math.max(4, ...results.map((r) => r.id.length));

  return (
    <Box flexDirection="column" marginTop={1}>
      {suiteName && (
        <Box marginBottom={1}>
          <Text bold>{"📚 "}</Text>
          <Text bold>{suiteName}</Text>
        </Box>
      )}

      {/* Header */}
      <Box>
        <Text bold>
          {pad("ID", idWidth)} │ Result │ Latency  │ Keywords │ Quotes │ Faithfulness
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          {"─".repeat(idWidth)}─┼────────┼──────────┼──────────┼────────┼─────────────
        </Text>
      </Box>

      {/* Rows */}
      {results.map((r) => (
        <Box key={r.id} flexDirection="column">
          <Box>
            <Text>{pad(r.id, idWidth)} │ </Text>
            {r.passed ? (
              <Text color="green">✅     </Text>
            ) : (
              <Text color="red">❌     </Text>
            )}
            <Text> │ {pad(`${r.latencyMs}ms`, 8)} │ {formatKeywords(r)} │ {formatQuotes(r)} │ </Text>
            <FaithfulnessCell f={r.faithfulness} />
          </Box>

          {/* Hallucination badge */}
          {r.faithfulness?.hallucinated && (
            <Box marginLeft={2}>
              <Text color="red">⚠ HALLUCINATED</Text>
            </Box>
          )}

          {/* Error line */}
          {r.error && (
            <Box marginLeft={2}>
              <Text color="red">⚠ {r.error}</Text>
            </Box>
          )}

          {/* Missed keywords */}
          {r.missedKeywords.length > 0 && (
            <Box marginLeft={2}>
              <Text color="red">
                ✗ Missing keywords: {r.missedKeywords.join(", ")}
              </Text>
            </Box>
          )}

          {/* Missed quotes */}
          {r.missedQuotes.length > 0 && (
            <Box marginLeft={2}>
              <Text color="red">
                ✗ Missing quotes: {r.missedQuotes.map((q) => `"${q}"`).join(", ")}
              </Text>
            </Box>
          )}
        </Box>
      ))}

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

// ── Helpers ───────────────────────────────────────────────────────

function pad(str: string, len: number): string {
  if (str.length >= len) return str;
  return str + " ".repeat(len - str.length);
}

function formatKeywords(r: RagTestCaseResult): string {
  const parts: string[] = [];
  if (r.matchedKeywords.length > 0) parts.push(`✓${r.matchedKeywords.length}`);
  if (r.missedKeywords.length > 0) parts.push(`✗${r.missedKeywords.length}`);
  return pad(parts.length > 0 ? parts.join(" ") : "—", 8);
}

function formatQuotes(r: RagTestCaseResult): string {
  const parts: string[] = [];
  if (r.matchedQuotes.length > 0) parts.push(`✓${r.matchedQuotes.length}`);
  if (r.missedQuotes.length > 0) parts.push(`✗${r.missedQuotes.length}`);
  return pad(parts.length > 0 ? parts.join(" ") : "—", 6);
}

/**
 * Inline faithfulness display — used inside JSX for color support.
 */
export const FaithfulnessCell: React.FC<{ f?: FaithfulnessScore }> = ({ f }) => {
  if (!f) return <Text>{"—"}</Text>;

  const pct = (f.score * 100).toFixed(0);
  const color: "green" | "yellow" | "red" =
    f.score >= 0.7 ? "green" : f.score >= 0.4 ? "yellow" : "red";

  return (
    <Text color={color}>
      {pct}%{f.hallucinated ? " ⚠" : ""}
    </Text>
  );
};

export default RagResult;
