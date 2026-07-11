/**
 * SessionPrompt — "Resume previous session? [Y/n]" prompt shown at chat start.
 */

import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Session } from "../../types";

interface SessionPromptProps {
  session: Session;
  onResume: () => void;
  onFresh: () => void;
}

const SessionPrompt: React.FC<SessionPromptProps> = ({
  session,
  onResume,
  onFresh,
}) => {
  const [answered, setAnswered] = useState(false);
  const { exit } = useApp();

  useInput((input, key) => {
    if (answered) return;

    if (key.return || input.toLowerCase() === "y") {
      setAnswered(true);
      onResume();
    } else if (input.toLowerCase() === "n") {
      setAnswered(true);
      onFresh();
    }
  });

  const messageCount = session.messages.length;
  const lastUpdated = new Date(session.updatedAt).toLocaleString();

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="yellow">
        📋 Previous session found
      </Text>
      <Box marginLeft={2} marginTop={1} flexDirection="column">
        <Text>
          <Text dimColor>Model:    </Text>
          <Text>{session.model}</Text>
        </Text>
        <Text>
          <Text dimColor>Messages: </Text>
          <Text>{messageCount}</Text>
        </Text>
        <Text>
          <Text dimColor>Updated:  </Text>
          <Text>{lastUpdated}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>Resume previous session? </Text>
        <Text color="cyan">[Y/n]</Text>
      </Box>
    </Box>
  );
};

export default SessionPrompt;
