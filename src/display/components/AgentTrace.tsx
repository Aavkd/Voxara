/**
 * AgentTrace — Live trace of agent loop steps.
 *
 * Phase C.5 (E1: Agentic Testing)
 *
 * Renders each tool call and final answer as they arrive.
 */

import React from "react";
import { Box, Text } from "ink";
import { AgentStepResult } from "../../types";

interface AgentTraceProps {
  steps: AgentStepResult[];
  finalAnswer?: string;
  isLoading: boolean;
}

const AgentTrace: React.FC<AgentTraceProps> = ({
  steps,
  finalAnswer,
  isLoading,
}) => {
  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Step trace */}
      {steps.map((step, idx) => (
        <Box key={idx} flexDirection="column">
          {step.type === "tool_call" ? (
            <Box>
              <Text color="cyan">{"→ "}</Text>
              <Text bold color="cyan">
                {step.toolName}
              </Text>
              <Text color="cyan">
                {"("}
                {step.toolParams
                  ? Object.entries(step.toolParams)
                      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                      .join(", ")
                  : ""}
                {")"}
              </Text>
              <Text dimColor>
                {"  "}
                {step.inputTokens}↑ {step.outputTokens}↓ tokens
              </Text>
            </Box>
          ) : (
            <Box>
              <Text color="green">{"✓ final_answer "}</Text>
              <Text dimColor>
                {step.inputTokens}↑ {step.outputTokens}↓ tokens
              </Text>
            </Box>
          )}
        </Box>
      ))}

      {/* Spinner / loading indicator */}
      {isLoading && (
        <Box>
          <Text color="yellow">{"⟳ "}</Text>
          <Text dimColor>thinking…</Text>
        </Box>
      )}

      {/* Final answer box */}
      {finalAnswer !== undefined && finalAnswer !== "" && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold>Final Answer</Text>
          <Text>{finalAnswer}</Text>
        </Box>
      )}
    </Box>
  );
};

export default AgentTrace;
