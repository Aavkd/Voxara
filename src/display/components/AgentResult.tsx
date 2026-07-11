/**
 * AgentResult — Table of AgentTestCaseResult[] with summary line.
 *
 * Phase C.5 (E1: Agentic Testing)
 *
 * Columns: id | pass/fail | steps | tools called | keywords | file assertions
 */

import React from "react";
import { Box, Text } from "ink";
import { AgentTestCaseResult } from "../../types";

interface AgentResultProps {
  results: AgentTestCaseResult[];
  suiteName?: string;
}

const AgentResult: React.FC<AgentResultProps> = ({ results, suiteName }) => {
  const passed = results.filter((r) => r.passed).length;
  const totalSteps = results.reduce((sum, r) => sum + r.steps, 0);

  const idWidth = Math.max(4, ...results.map((r) => r.id.length));

  return (
    <Box flexDirection="column" marginTop={1}>
      {suiteName && (
        <Box marginBottom={1}>
          <Text bold>{"🤖 "}</Text>
          <Text bold>{suiteName}</Text>
        </Box>
      )}

      {/* Header */}
      <Box>
        <Text bold>
          {pad("ID", idWidth)} │ Result │ Steps │ Tools Called │ Keywords │ Files
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          {"─".repeat(idWidth)}─┼────────┼───────┼──────────────┼──────────┼──────
        </Text>
      </Box>

      {/* Rows */}
      {results.map((r) => (
        <Box key={r.id} flexDirection="column">
          <Box>
            <Text>
              {pad(r.id, idWidth)} │{" "}
              {r.passed ? (
                <Text color="green">✅     </Text>
              ) : (
                <Text color="red">❌     </Text>
              )}{" "}
              │ {pad(String(r.steps), 5)} │ {formatTools(r)} │{" "}
              {formatKeywords(r)} │ {formatFiles(r)}
            </Text>
          </Box>

          {/* Error line */}
          {r.error && (
            <Box marginLeft={2}>
              <Text color="red">⚠ {r.error}</Text>
            </Box>
          )}

          {/* Missed tool calls */}
          {r.missedToolCalls.length > 0 && (
            <Box marginLeft={2}>
              <Text color="red">
                ✗ Missing tool calls: {r.missedToolCalls.join(", ")}
              </Text>
            </Box>
          )}
        </Box>
      ))}

      {/* Summary */}
      <Box marginTop={1}>
        <Text>
          Passed: <Text color={passed === results.length ? "green" : "red"}>{passed}/{results.length}</Text>
          {"  "}Total steps: <Text bold>{totalSteps}</Text>
        </Text>
      </Box>
    </Box>
  );
};

function pad(str: string, len: number): string {
  if (str.length >= len) return str;
  return str + " ".repeat(len - str.length);
}

function formatTools(r: AgentTestCaseResult): string {
  if (r.toolCallsMade.length === 0) return "—            ";
  const names = [...new Set(r.toolCallsMade.map((t) => t.name))];
  return pad(names.join(", "), 12);
}

function formatKeywords(r: AgentTestCaseResult): string {
  const parts: string[] = [];
  if (r.matchedKeywords.length > 0) parts.push(`✓${r.matchedKeywords.length}`);
  if (r.missedKeywords.length > 0) parts.push(`✗${r.missedKeywords.length}`);
  return parts.length > 0 ? pad(parts.join(" "), 8) : pad("—", 8);
}

function formatFiles(r: AgentTestCaseResult): string {
  if (r.fileAssertionResults.length === 0) return "—";
  const passCount = r.fileAssertionResults.filter((f) => f.passed).length;
  return `${passCount}/${r.fileAssertionResults.length}`;
}

export default AgentResult;
