/**
 * PromptResult — Renders a PromptResult with response text, latency badge, and token usage.
 */

import React from "react";
import { Box, Text } from "ink";
import { PromptResult as PromptResultType } from "../../types";

interface PromptResultProps {
  result: PromptResultType;
}

const PromptResultDisplay: React.FC<PromptResultProps> = ({ result }) => {
  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Response text */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="green">
          Response:
        </Text>
        <Box marginLeft={2} marginTop={1}>
          <Text>{result.text}</Text>
        </Box>
      </Box>

      {/* Stats row */}
      <Box flexDirection="row" marginTop={1}>
        <Box marginRight={3}>
          <Text dimColor>⏱  </Text>
          <Text color="yellow" bold>
            {result.latencyMs}ms
          </Text>
        </Box>
        <Box marginRight={3}>
          <Text dimColor>📥 </Text>
          <Text>{result.inputTokens} in</Text>
        </Box>
        <Box marginRight={3}>
          <Text dimColor>📤 </Text>
          <Text>{result.outputTokens} out</Text>
        </Box>
        <Box marginRight={3}>
          <Text dimColor>📊 </Text>
          <Text>{result.totalTokens} total</Text>
        </Box>
        <Box>
          <Text dimColor>🏁 </Text>
          <Text>{result.finishReason}</Text>
        </Box>
      </Box>
    </Box>
  );
};

export default PromptResultDisplay;
