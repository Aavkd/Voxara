/**
 * prompt command — Send a single prompt and display the response.
 */

import React from "react";
import { render } from "ink";
import { loadConfig } from "../config/loader";
import { createProvider } from "../providers/factory";
import { PromptResultDisplay } from "../display";
import { PromptInput, PromptResult } from "../types";

export async function promptCommand(
  text: string,
  options: {
    key?: string;
    model?: string;
    temperature?: string;
    maxTokens?: string;
    systemPrompt?: string;
    image?: string;
  }
): Promise<void> {
  // Parse and validate numeric options before any API call
  let temperature: number | undefined;
  if (options.temperature !== undefined) {
    temperature = parseFloat(options.temperature);
    if (isNaN(temperature)) {
      console.error(
        `Error: Invalid temperature value "${options.temperature}". Must be a number between 0 and 2.`
      );
      process.exit(1);
      return;
    }
    if (temperature < 0 || temperature > 2) {
      console.error(
        `Error: Temperature must be between 0 and 2, got ${temperature}.`
      );
      process.exit(1);
      return;
    }
  }

  let maxTokens: number | undefined;
  if (options.maxTokens !== undefined) {
    maxTokens = parseInt(options.maxTokens, 10);
    if (isNaN(maxTokens)) {
      console.error(
        `Error: Invalid max-tokens value "${options.maxTokens}". Must be a positive integer.`
      );
      process.exit(1);
      return;
    }
    if (maxTokens <= 0) {
      console.error(
        `Error: max-tokens must be greater than 0, got ${maxTokens}.`
      );
      process.exit(1);
      return;
    }
  }

  const config = loadConfig({
    apiKey: options.key,
    model: options.model,
  });

  const provider = createProvider(config);

  const input: PromptInput = {
    prompt: text,
    model: options.model || config.model,
    temperature,
    maxTokens,
    systemPrompt: options.systemPrompt,
    image: options.image,
  };

  const ora = await import("ora");
  const spinner = ora.default("Sending prompt…").start();

  let result: PromptResult;
  try {
    result = await provider.prompt(input);
  } catch (err: unknown) {
    spinner.fail("Prompt failed");
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
    return;
  }

  spinner.stop();

  const { waitUntilExit } = render(
    React.createElement(PromptResultDisplay, { result })
  );
  await waitUntilExit();

  process.exit(0);
}
