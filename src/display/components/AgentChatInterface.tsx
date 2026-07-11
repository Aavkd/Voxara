/**
 * AgentChatInterface — Interactive agent chat TUI with live tool-use trace.
 *
 * Phase J.1 (E8: Agent Chat)
 *
 * Renders message history, an inline trace panel while the agent is working,
 * a status footer, and a keyboard-driven input line.
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Message, AgentStepResult } from "../../types";
import ChatMessage from "./ChatMessage";

interface AgentChatInterfaceProps {
  messages: Message[];
  activeTools: string[];
  loadedDocs: string[];
  isAgentWorking: boolean;
  currentTrace: AgentStepResult[];
  onSubmit: (text: string) => void;
  cumulativeTokens: { input: number; output: number };
  model: string;
}

const AgentChatInterface: React.FC<AgentChatInterfaceProps> = ({
  messages,
  activeTools,
  loadedDocs,
  isAgentWorking,
  currentTrace,
  onSubmit,
  cumulativeTokens,
  model,
}) => {
  const { exit } = useApp();
  const [inputText, setInputText] = useState("");

  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    setInputText("");

    if (text === "/exit") {
      onSubmit(text);
      exit();
      return;
    }

    onSubmit(text);
  }, [inputText, onSubmit, exit]);

  useInput((input, key) => {
    if (isAgentWorking) return;

    if (key.return) {
      handleSubmit();
      return;
    }

    if (key.backspace || key.delete) {
      setInputText((prev) => prev.slice(0, -1));
      return;
    }

    if (input === "\x03") {
      onSubmit("/exit");
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
        <Text bold color="magenta">{"🤖 llmtest agent-chat"}</Text>
        <Text dimColor>{` — ${model}`}</Text>
      </Box>

      {/* Message history */}
      {messages.map((msg, i) => (
        <ChatMessage key={i} message={msg} />
      ))}

      {/* Inline trace panel — shown only while agent is working */}
      {isAgentWorking && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          {currentTrace.map((step, idx) => (
            <Box key={idx}>
              {step.type === "tool_call" ? (
                <Text color="cyan">
                  {"→ "}
                  <Text bold>{step.toolName}</Text>
                  {"("}
                  {step.toolParams
                    ? Object.entries(step.toolParams)
                        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                        .join(", ")
                    : ""}
                  {")"}
                  <Text dimColor>
                    {" ✓ "}
                    {step.text
                      ? step.text.slice(0, 60) + (step.text.length > 60 ? "…" : "")
                      : ""}
                  </Text>
                </Text>
              ) : (
                <Text color="green">{"✓ final_answer"}</Text>
              )}
            </Box>
          ))}
          <Box>
            <Text color="yellow">{"⟳ "}</Text>
            <Text dimColor>{"agent working…"}</Text>
          </Box>
        </Box>
      )}

      {/* Footer bar */}
      <Box marginTop={1} borderStyle="single" paddingX={1}>
        <Text dimColor>
          {`${model} | tools: ${activeTools.length} active | docs: ${loadedDocs.length} loaded | ↑ ${cumulativeTokens.input} ↓ ${cumulativeTokens.output} tokens`}
        </Text>
      </Box>

      {/* Input line */}
      <Box marginTop={1}>
        {isAgentWorking ? (
          <Text dimColor>{"⏳ Agent is working, please wait…"}</Text>
        ) : (
          <Text>
            <Text bold color="magenta">{">"}</Text>
            <Text>{" "}</Text>
            <Text>{inputText || ""}</Text>
            <Text color="cyan">{"▊"}</Text>
          </Text>
        )}
      </Box>

      {/* Help footer */}
      <Box marginTop={1}>
        <Text dimColor>
          {"/tools /docs <path> /info /clear /model <name> /exit | Ctrl+C to quit"}
        </Text>
      </Box>
    </Box>
  );
};

export default AgentChatInterface;
