/**
 * ChatInterface — Full chat TUI with message history, streaming input, and token counters.
 *
 * Supports streaming: re-renders as onChunk delivers text.
 * Handles slash commands: /clear, /model <name>, /info, /exit
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Message } from "../../types";
import ChatMessage from "./ChatMessage";

interface ChatInterfaceProps {
  initialMessages: Message[];
  model: string;
  onSendMessage: (
    text: string,
    onChunk: (chunk: string) => void
  ) => Promise<{ inputTokens: number; outputTokens: number; fullText: string }>;
  /** Returns true when handled; a string is displayed as the command's output. */
  onSlashCommand: (command: string, args: string) => boolean | string;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({
  initialMessages,
  model,
  onSendMessage,
  onSlashCommand,
}) => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [inputText, setInputText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [totalInputTokens, setTotalInputTokens] = useState(0);
  const [totalOutputTokens, setTotalOutputTokens] = useState(0);
  const [currentModel, setCurrentModel] = useState(model);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    const text = inputText.trim();
    if (!text) return;

    setInputText("");
    setInfoMessage(null);

    // Check for slash commands
    if (text.startsWith("/")) {
      const spaceIdx = text.indexOf(" ");
      const cmd = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

      if (cmd === "exit") {
        exit();
        return;
      }

      if (cmd === "clear") {
        setMessages([]);
        setTotalInputTokens(0);
        setTotalOutputTokens(0);
        onSlashCommand("clear", "");
        setInfoMessage("Session cleared.");
        return;
      }

      if (cmd === "model" && args) {
        setCurrentModel(args);
        onSlashCommand("model", args);
        setInfoMessage(`Model switched to: ${args}`);
        return;
      }

      if (cmd === "info") {
        setInfoMessage(
          `Model: ${currentModel} | Messages: ${messages.length} | Tokens: ${totalInputTokens} in / ${totalOutputTokens} out`
        );
        return;
      }

      // Unknown slash command — pass through to handler
      const handled = onSlashCommand(cmd, args);
      if (typeof handled === "string") {
        setInfoMessage(handled);
      } else if (!handled) {
        setInfoMessage(`Unknown command: /${cmd}. Available: /clear, /model <name>, /info, /memory, /exit`);
      }
      return;
    }

    // Regular message
    const userMessage: Message = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsStreaming(true);
    setStreamingText("");

    try {
      const result = await onSendMessage(text, (chunk) => {
        setStreamingText((prev) => prev + chunk);
      });

      const modelMessage: Message = {
        role: "model",
        content: result.fullText,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, modelMessage]);
      setTotalInputTokens((prev) => prev + result.inputTokens);
      setTotalOutputTokens((prev) => prev + result.outputTokens);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setInfoMessage(`Error: ${errMsg}`);
    } finally {
      setIsStreaming(false);
      setStreamingText("");
    }
  }, [inputText, messages, currentModel, totalInputTokens, totalOutputTokens, onSendMessage, onSlashCommand, exit]);

  useInput((input, key) => {
    if (isStreaming) return;

    if (key.return) {
      handleSubmit();
      return;
    }

    if (key.backspace || key.delete) {
      setInputText((prev) => prev.slice(0, -1));
      return;
    }

    // Ctrl+C
    if (input === "\x03") {
      exit();
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      setInputText((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">{'💬 llmtest chat'}</Text>
        <Text dimColor>{` — ${currentModel} | ${totalInputTokens + totalOutputTokens} tokens used`}</Text>
      </Box>

      {/* Message history */}
      {messages.map((msg, i) => (
        <ChatMessage key={i} message={msg} />
      ))}

      {/* Streaming response */}
      {isStreaming && streamingText ? (
        <ChatMessage
          message={{
            role: "model",
            content: streamingText,
            timestamp: Date.now(),
          }}
          isStreaming={true}
        />
      ) : null}

      {/* Info/status message */}
      {infoMessage ? (
        <Box marginBottom={1}>
          <Text color="yellow">{`ℹ ${infoMessage}`}</Text>
        </Box>
      ) : null}

      {/* Input line */}
      <Box>
        {isStreaming ? (
          <Text dimColor>{'⏳ Streaming response…'}</Text>
        ) : (
          <Text>
            <Text bold color="blue">{'> '}</Text>
            <Text>{inputText || ''}</Text>
            <Text color="cyan">{'▊'}</Text>
          </Text>
        )}
      </Box>

      {/* Help footer */}
      <Box marginTop={1}>
        <Text dimColor>{'/clear /model <name> /info /memory /exit | Ctrl+C to quit'}</Text>
      </Box>
    </Box>
  );
};

export default ChatInterface;
