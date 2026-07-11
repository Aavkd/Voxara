/**
 * JudgeScore — Renders a JudgeResult as a colored score bar with reason.
 *
 * Phase B.2 (E6: LLM-as-Judge display component)
 */

import React from "react";
import { Box, Text } from "ink";
import { JudgeResult, JudgeCriteria } from "../../types";

interface JudgeScoreProps {
  result: JudgeResult;
  criteria: string;
}

const BAR_WIDTH = 10;

const JudgeScore: React.FC<JudgeScoreProps> = ({ result, criteria }) => {
  const { score, reason, passed } = result;

  // Color thresholds: green ≥ 7, yellow 4–6, red ≤ 3
  const color = score >= 7 ? "green" : score >= 4 ? "yellow" : "red";

  // ASCII block bar proportional to the score (0–10 → 0–10 blocks)
  const filledBlocks = Math.max(0, Math.min(BAR_WIDTH, score));
  const emptyBlocks = BAR_WIDTH - filledBlocks;
  const bar = "█".repeat(filledBlocks) + "░".repeat(emptyBlocks);

  const badge = passed ? "✅ PASS" : "❌ FAIL";

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text dimColor>Judge </Text>
        <Text bold color={color}>
          {score}/10
        </Text>
        <Text dimColor> [{bar}] </Text>
        <Text color={passed ? "green" : "red"}>{badge}</Text>
      </Box>
      <Box>
        <Text dimColor>  Criteria: {criteria}</Text>
      </Box>
      <Box>
        <Text dimColor>  Reason: {reason}</Text>
      </Box>
    </Box>
  );
};

export default JudgeScore;
