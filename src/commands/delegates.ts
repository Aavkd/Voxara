/**
 * delegates command — inspect and manage delegated coding-agent tasks.
 *
 * Phase C2a (docs/phase-c2-coding-agent-delegation.md §14):
 *   llmtest delegates doctor       backend/config health without running a task
 *   llmtest delegates list         recent tasks and status
 *   llmtest delegates show <id>    summary, approval request, bounded progress
 *   llmtest delegates cancel <id>  cancel a task
 */

import { Command } from "commander";
import { loadVoiceConfig } from "../config/loader";
import { getDelegationService } from "../delegation/service";

/** Ensure .env files are loaded before the delegation config is read. */
function loadEnv(): void {
  loadVoiceConfig();
}

export function delegatesCommand(): Command {
  const command = new Command("delegates");
  command.description("Inspect and manage delegated coding-agent tasks");

  command
    .command("doctor")
    .description("Report backend availability, allowed roots, and policy configuration")
    .action(async () => {
      loadEnv();
      const service = getDelegationService();
      const config = service.getConfig();

      console.log("Delegation configuration");
      console.log(`  Enabled:            ${config.enabled ? "yes" : "no (set DELEGATION_ENABLED=true)"}`);
      console.log(`  Default backend:    ${config.defaultBackend}`);
      console.log(`  Allowed roots:      ${config.allowedRoots.join(", ")}`);
      console.log(
        `  Agent-owned roots:  ${
          config.agentOwnedRoots.length > 0
            ? config.agentOwnedRoots.join(", ") + " (writes run directly, git-checkpointed)"
            : "(none — check DELEGATION_AGENT_OWNED_ROOTS is inside the allowed roots)"
        }`
      );
      console.log(`  Max concurrent:     ${config.maxConcurrent}`);
      console.log(`  Timeout (default):  ${config.defaultTimeoutMinutes} min (max ${config.maxTimeoutMinutes})`);
      console.log(`  Output cap:         ${config.maxOutputBytes} bytes`);
      console.log(`  Artifact retention: ${config.artifactRetentionDays} days`);
      console.log(
        `  Allowed programs:   ${
          config.allowedPrograms.length > 0
            ? config.allowedPrograms.join(", ")
            : "(none — external_action execute steps are unavailable)"
        }`
      );
      console.log("");
      console.log("Backends");

      const backends = await service.detectBackends();
      for (const backend of backends) {
        if (backend.available) {
          console.log(`  ${backend.name}: OK — ${backend.version ?? "?"} (${backend.executablePath})`);
        } else {
          console.log(`  ${backend.name}: unavailable — ${backend.problem}`);
        }
      }

      if (!config.enabled) {
        console.log("");
        console.log(
          "Delegation is disabled. Set DELEGATION_ENABLED=true and configure " +
            "DELEGATION_ALLOWED_ROOTS in your .env to enable it."
        );
      }
    });

  command
    .command("list")
    .description("List recent delegated tasks and their status")
    .action(() => {
      loadEnv();
      const tasks = getDelegationService().list(20);
      if (tasks.length === 0) {
        console.log("No delegated tasks.");
        return;
      }
      for (const task of tasks) {
        const objective = (task.task ?? "").replace(/\s+/g, " ").slice(0, 70);
        console.log(
          `${task.id}  ${task.status.padEnd(16)} ${(task.backend ?? "?").padEnd(7)} ${objective}`
        );
      }
    });

  command
    .command("show <id>")
    .description("Show one delegated task: summary, approval request, recent progress")
    .action((id: string) => {
      loadEnv();
      const summary = getDelegationService().status(id);
      if (!summary.found) {
        console.error(summary.text);
        process.exit(1);
        return;
      }
      console.log(summary.text);
    });

  command
    .command("cancel <id>")
    .description("Cancel a pending or running delegated task")
    .action(async (id: string) => {
      loadEnv();
      const message = await getDelegationService().cancel(id);
      if (message.startsWith("error:")) {
        console.error(message);
        process.exit(1);
        return;
      }
      console.log(message);
    });

  return command;
}
