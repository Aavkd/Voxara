/**
 * Provider Factory — returns the correct ILLMProvider implementation
 * based on the resolved AppConfig.provider value.
 */

import { AppConfig } from "../types";
import { ILLMProvider } from "./ILLMProvider";
import { GoogleProvider } from "./google";
import { GitHubProvider } from "./github";
import { OllamaProvider } from "./ollama";

/**
 * Create and return the appropriate provider for the given config.
 * Defaults to GoogleProvider when provider is unrecognized.
 */
export function createProvider(config: AppConfig): ILLMProvider {
  switch (config.provider) {
    case "github":
      return new GitHubProvider(config);
    case "ollama":
      return new OllamaProvider(config);
    case "google":
    default:
      return new GoogleProvider(config);
  }
}
