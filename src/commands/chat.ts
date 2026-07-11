/**
 * chat command — Interactive chat session with streaming responses.
 */

import React from "react";
import { render } from "ink";
import { loadConfig } from "../config/loader";
import { createProvider } from "../providers/factory";
import {
  loadSession,
  saveSession,
  clearSession,
  createSession,
} from "../session/session";
import { ChatInterface, SessionPrompt } from "../display";
import { Message, Session, AppConfig } from "../types";

export async function chatCommand(options: {
  key?: string;
  model?: string;
}): Promise<void> {
  const config = loadConfig({
    apiKey: options.key,
    model: options.model,
  });

  const existingSession = loadSession();

  if (existingSession) {
    // Ask user whether to resume or start fresh
    const shouldResume = await promptSessionResume(existingSession);

    if (shouldResume) {
      await startChat(config, existingSession);
    } else {
      clearSession();
      const newSession = createSession(config.model);
      await startChat(config, newSession);
    }
  } else {
    const newSession = createSession(config.model);
    await startChat(config, newSession);
  }
}

/**
 * Show the session resume prompt and return the user's choice.
 */
function promptSessionResume(session: Session): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const { unmount } = render(
      React.createElement(SessionPrompt, {
        session,
        onResume: () => {
          unmount();
          resolve(true);
        },
        onFresh: () => {
          unmount();
          resolve(false);
        },
      })
    );
  });
}

/**
 * Start the interactive chat with the given session.
 */
async function startChat(config: AppConfig, session: Session): Promise<void> {
  let provider = createProvider(config);
  let currentConfig = { ...config };

  const handleSendMessage = async (
    text: string,
    onChunk: (chunk: string) => void
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    fullText: string;
  }> => {
    // Add user message to session
    const userMessage: Message = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    session.messages.push(userMessage);

    // Stream the response
    const result = await provider.streamChat(session.messages, onChunk);

    // Add model message to session
    session.messages.push(result.message);
    saveSession(session);

    return {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      fullText: result.message.content,
    };
  };

  const handleSlashCommand = (command: string, args: string): boolean => {
    switch (command) {
      case "clear":
        session.messages = [];
        clearSession();
        return true;

      case "model":
        if (args) {
          currentConfig = { ...currentConfig, model: args };
          session.model = args;
          provider = createProvider(currentConfig);
          saveSession(session);
          return true;
        }
        return false;

      case "info":
        // Handled in the component
        return true;

      default:
        return false;
    }
  };

  const { waitUntilExit } = render(
    React.createElement(ChatInterface, {
      initialMessages: session.messages,
      model: currentConfig.model,
      onSendMessage: handleSendMessage,
      onSlashCommand: handleSlashCommand,
    })
  );

  await waitUntilExit();
  process.exit(0);
}
