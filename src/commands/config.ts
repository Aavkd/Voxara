/**
 * config command — Display the resolved configuration.
 */

import { loadConfig, printConfig } from "../config/loader";

export async function configCommand(): Promise<void> {
  const config = loadConfig();
  printConfig(config);
  process.exit(0);
}
