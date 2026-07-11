/**
 * validate command — Validate the configured API key.
 */

import React from "react";
import { render } from "ink";
import { loadConfig } from "../config/loader";
import { createProvider } from "../providers/factory";
import { ValidationResultDisplay } from "../display";
import { ValidationResult } from "../types";

export async function validateCommand(options: {
  key?: string;
  model?: string;
}): Promise<void> {
  const config = loadConfig({
    apiKey: options.key,
    model: options.model,
  });

  const provider = createProvider(config);

  // Use ora for spinner in non-ink context
  const ora = await import("ora");
  const spinner = ora.default("Validating API key…").start();

  let result: ValidationResult;
  try {
    result = await provider.validate();
  } catch (err: unknown) {
    spinner.fail("Validation failed unexpectedly");
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
    return;
  }

  spinner.stop();

  // Render the result via ink
  const { waitUntilExit } = render(
    React.createElement(ValidationResultDisplay, { result })
  );
  await waitUntilExit();

  process.exit(result.valid ? 0 : 1);
}
