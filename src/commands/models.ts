/**
 * models command — List available models for the configured provider.
 */

import React from "react";
import { render, Box, Text } from "ink";
import { loadConfig } from "../config/loader";
import { createProvider } from "../providers/factory";

export async function modelsCommand(options: {
  key?: string;
  model?: string;
}): Promise<void> {
  const config = loadConfig({
    apiKey: options.key,
    model: options.model,
  });

  const provider = createProvider(config);

  const ora = await import("ora");
  const spinner = ora.default("Fetching available models…").start();

  if (!provider.listModels) {
    console.log(`⚠  Provider "${config.provider}" does not support model listing.`);
    process.exit(0);
    return;
  }

  let models: string[];
  try {
    models = await provider.listModels();
  } catch (err: unknown) {
    spinner.fail("Failed to fetch models");
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
    return;
  }

  spinner.stop();

  if (models.length === 0) {
    const { waitUntilExit } = render(
      React.createElement(
        Box,
        { flexDirection: "column", marginTop: 1 },
        React.createElement(
          Text,
          { color: "yellow" },
          "⚠ No models returned. The model list API may be unavailable."
        ),
        React.createElement(
          Text,
          { dimColor: true },
          "Visit https://ai.google.dev/models for available Gemini models."
        )
      )
    );
    await waitUntilExit();
  } else {
    const { waitUntilExit } = render(
      React.createElement(
        Box,
        { flexDirection: "column", marginTop: 1 },
        React.createElement(
          Text,
          { bold: true, color: "green" },
          "Available models:"
        ),
        React.createElement(
          Box,
          { flexDirection: "column", marginTop: 1, marginLeft: 2 },
          ...models.map((model, i) =>
            React.createElement(
              Text,
              { key: i },
              React.createElement(Text, { dimColor: true }, "• "),
              model
            )
          )
        ),
        React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(
            Text,
            { dimColor: true },
            `${models.length} models found`
          )
        )
      )
    );
    await waitUntilExit();
  }

  process.exit(0);
}
