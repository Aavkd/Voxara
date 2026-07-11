/**
 * CompareTable — Side-by-side model comparison table.
 *
 * Rows = test case IDs. Columns = one per model.
 * Each cell shows ✅/❌ with latency in ms.
 * Footer: pass rate (N/M) and avg latency per model.
 * The winning model (most passes; lowest latency as tiebreaker) is highlighted green.
 */

import React from "react";
import { Box, Text } from "ink";
import { TestCaseResult } from "../../types";

interface CompareTableProps {
  models: string[];
  results: Map<string, TestCaseResult[]>;
}

const CompareTable: React.FC<CompareTableProps> = ({ models, results }) => {
  if (models.length === 0) return null;

  const firstModelResults = results.get(models[0]) ?? [];
  const testIds = firstModelResults.map((r) => r.id);

  // Calculate column widths
  const idWidth = Math.max(7, ...testIds.map((id) => id.length));
  const cellWidth = Math.max(
    12,
    ...models.map((m) => m.length)
  );

  // Compute per-model stats for the footer
  const modelStats = models.map((model) => {
    const modelResults = results.get(model) ?? [];
    const passed = modelResults.filter((r) => r.passed).length;
    const total = modelResults.length;
    const avgLatency =
      total > 0
        ? Math.round(modelResults.reduce((s, r) => s + r.latencyMs, 0) / total)
        : 0;
    return { model, passed, total, avgLatency };
  });

  // Determine winner: most passes, then lowest avg latency
  const winner = modelStats.reduce((best, cur) => {
    if (cur.passed > best.passed) return cur;
    if (cur.passed === best.passed && cur.avgLatency < best.avgLatency)
      return cur;
    return best;
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header row */}
      <Box>
        <Text bold>{pad("Test ID", idWidth)}</Text>
        {models.map((model) => (
          <Text bold key={model}>
            {" │ "}
            {model === winner.model ? (
              <Text color="green">{pad(model, cellWidth)}</Text>
            ) : (
              pad(model, cellWidth)
            )}
          </Text>
        ))}
      </Box>

      {/* Separator */}
      <Box>
        <Text dimColor>
          {"─".repeat(idWidth)}
          {models.map(() => `─┼─${"─".repeat(cellWidth)}`).join("")}
        </Text>
      </Box>

      {/* Data rows */}
      {testIds.map((id) => (
        <Box key={id}>
          <Text>{pad(id, idWidth)}</Text>
          {models.map((model) => {
            const modelResults = results.get(model) ?? [];
            const r = modelResults.find((x) => x.id === id);
            if (!r) {
              return (
                <Text key={model} dimColor>
                  {" │ "}{pad("—", cellWidth)}
                </Text>
              );
            }
            const cell = r.passed
              ? `✅ ${r.latencyMs}ms`
              : `❌ ${r.latencyMs}ms`;
            return (
              <Text key={model} color={r.passed ? "green" : "red"}>
                {" │ "}{pad(cell, cellWidth)}
              </Text>
            );
          })}
        </Box>
      ))}

      {/* Separator before footer */}
      <Box>
        <Text dimColor>
          {"─".repeat(idWidth)}
          {models.map(() => `─┼─${"─".repeat(cellWidth)}`).join("")}
        </Text>
      </Box>

      {/* Footer: pass rate row */}
      <Box>
        <Text bold>{pad("Pass rate", idWidth)}</Text>
        {modelStats.map(({ model, passed, total }) => {
          const cell = `${passed}/${total}`;
          return (
            <Text bold key={model} color={model === winner.model ? "green" : undefined}>
              {" │ "}{pad(cell, cellWidth)}
            </Text>
          );
        })}
      </Box>

      {/* Footer: avg latency row */}
      <Box>
        <Text bold>{pad("Avg latency", idWidth)}</Text>
        {modelStats.map(({ model, avgLatency }) => {
          const cell = `${avgLatency}ms`;
          return (
            <Text bold key={model} color={model === winner.model ? "green" : undefined}>
              {" │ "}{pad(cell, cellWidth)}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
};

function pad(str: string, len: number): string {
  if (str.length >= len) return str;
  return str + " ".repeat(len - str.length);
}

export default CompareTable;
