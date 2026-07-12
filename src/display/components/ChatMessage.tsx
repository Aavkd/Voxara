/**
 * ChatMessage — Renders a single chat message with role label and content.
 */

import React from "react";
import { Box, Text } from "ink";
import { Message, messageText } from "../../types";

interface ChatMessageProps {
  message: Message;
  isStreaming?: boolean;
}

const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  isStreaming = false,
}) => {
  const isUser = message.role === "user";
  const label = isUser ? "You" : "Model";
  const labelColor = isUser ? "blue" : "green";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={labelColor}>
          {label}:
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Text>
          {messageText(message)}
          {isStreaming && <Text color="cyan">▊</Text>}
        </Text>
      </Box>
    </Box>
  );
};

export default ChatMessage;
