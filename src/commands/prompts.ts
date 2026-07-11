import { Command } from "commander";
import { validatePrompts } from "../prompts/promptLoader";

export function promptsCommand(): Command {
  const command = new Command("prompts");

  command
    .description("Inspect and validate editable prompt files")
    .command("check")
    .description("Validate required prompt files and template variables")
    .option("--dir <path>", "Prompt directory override")
    .option("--debug", "Treat unregistered template variables as errors")
    .action((options: { dir?: string; debug?: boolean }) => {
      const result = validatePrompts({
        promptsDir: options.dir,
        debug: options.debug ?? process.env.LLMTEST_LOG_LEVEL === "debug",
      });

      console.log(`Prompts directory: ${result.promptsDir}`);
      console.log(`Checked ${result.checked.length} prompt files.`);

      for (const warning of result.warnings) {
        console.warn(`Warning: ${warning}`);
      }

      if (!result.ok) {
        for (const error of result.errors) {
          console.error(`Error: ${error}`);
        }
        process.exit(1);
        return;
      }

      console.log("Prompt check passed.");
    });

  return command;
}
