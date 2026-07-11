/**
 * ValidationResult — Renders ✅/❌ with error details if invalid.
 */

import React from "react";
import { Box, Text } from "ink";
import { ValidationResult as ValidationResultType } from "../../types";

interface ValidationResultProps {
  result: ValidationResultType;
}

const ValidationResultDisplay: React.FC<ValidationResultProps> = ({
  result,
}) => {
  if (result.valid) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color="green" bold>
            ✅ API key is valid
          </Text>
        </Text>
        {result.modelAccess && result.modelAccess.length > 0 && (
          <Box flexDirection="column" marginTop={1} marginLeft={2}>
            <Text dimColor>Accessible models:</Text>
            {result.modelAccess.map((model, i) => (
              <Text key={i}>
                <Text dimColor>  • </Text>
                <Text>{model}</Text>
              </Text>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color="red" bold>
          ❌ API key validation failed
        </Text>
      </Text>
      {result.errorCode && (
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>Error code: </Text>
          <Text color="red">{result.errorCode}</Text>
        </Box>
      )}
      {result.errorMessage && (
        <Box marginLeft={2}>
          <Text dimColor>Message:    </Text>
          <Text>{result.errorMessage}</Text>
        </Box>
      )}
    </Box>
  );
};

export default ValidationResultDisplay;
