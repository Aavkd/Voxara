/**
 * memory command — Inspect and edit the long-term memory files by hand.
 *
 * Phase M1 (docs/memory-architecture-spec.md §7), M2: consolidate + forget,
 * M3: consolidate --deep (full hygiene pass).
 */

import { spawn } from "child_process";
import { Command } from "commander";
import { loadConfig } from "../config/loader";
import { runConsolidation } from "../memory/consolidation";
import {
  ensureMemoryLayout,
  listMemoryEntries,
  readMemoryEntry,
  readMemoryIndex,
  countInboxNotes,
  archiveMemoryEntry,
} from "../memory/memoryStore";

export function memoryCommand(): Command {
  const command = new Command("memory");
  command.description("Inspect and edit the assistant's long-term memory files");

  command
    .command("list")
    .description("Show the memory index and entry counts")
    .action(() => {
      const paths = ensureMemoryLayout();
      const entries = listMemoryEntries();
      const facts = entries.filter((entry) => entry.type === "fact").length;
      const episodes = entries.filter((entry) => entry.type === "episode").length;
      const inbox = countInboxNotes();

      console.log(`Memory directory: ${paths.root}`);
      console.log(
        `Facts: ${facts} | Episodes: ${episodes} | Inbox notes pending: ${inbox}`
      );
      console.log("");
      console.log(readMemoryIndex().trim() || "(empty index)");
    });

  command
    .command("show <id>")
    .description("Print one memory entry (fact or episode) by id")
    .action((id: string) => {
      ensureMemoryLayout();
      const entry = readMemoryEntry(id);
      if (!entry) {
        console.error(`No memory entry found with id "${id}".`);
        const known = listMemoryEntries()
          .map((item) => item.id)
          .join(", ");
        console.error(`Known ids: ${known || "(none)"}`);
        process.exit(1);
        return;
      }

      console.log(entry.content.trimEnd());
    });

  command
    .command("edit <id>")
    .description("Open one memory entry in your editor ($EDITOR, or notepad)")
    .action(async (id: string) => {
      ensureMemoryLayout();
      const entry = readMemoryEntry(id);
      if (!entry) {
        console.error(`No memory entry found with id "${id}".`);
        process.exit(1);
        return;
      }

      const filePath = listMemoryEntries().find(
        (item) => item.id === id && item.type === entry.type
      )?.filePath;
      if (!filePath) {
        console.error(`Could not locate the file for "${id}".`);
        process.exit(1);
        return;
      }

      const editorSetting =
        process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano");
      const [editor, ...editorArgs] = editorSetting.split(/\s+/);

      await new Promise<void>((resolve) => {
        const child = spawn(editor, [...editorArgs, filePath], {
          stdio: "inherit",
          shell: false,
        });
        child.on("exit", () => resolve());
        child.on("error", (err) => {
          console.error(`Could not launch editor "${editorSetting}": ${err.message}`);
          console.error(`Edit the file directly: ${filePath}`);
          resolve();
        });
      });
    });

  command
    .command("consolidate")
    .description("Force a memory consolidation run now (episodes, facts, inbox)")
    .option("--deep", "also run the full hygiene pass (merge duplicates, resolve contradictions)")
    .action(async (opts: { deep?: boolean }) => {
      ensureMemoryLayout();

      let config;
      try {
        config = loadConfig();
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
        return;
      }

      console.log(opts.deep ? "Consolidating memory (deep)…" : "Consolidating memory…");
      const result = await runConsolidation({
        config,
        deep: opts.deep === true,
        log: (message) => console.log(message),
      });

      console.log(`Sessions consolidated: ${result.consolidated.length}`);
      console.log(`Sessions already up to date: ${result.skipped.length}`);
      console.log(`Facts written/updated: ${result.factsWritten.length}${result.factsWritten.length > 0 ? ` (${result.factsWritten.join(", ")})` : ""}`);
      console.log(`Entries archived: ${result.archivedIds.length}${result.archivedIds.length > 0 ? ` (${result.archivedIds.join(", ")})` : ""}`);
      console.log(`Inbox notes filed: ${result.inboxProcessed}`);

      const hygiene = result.hygiene;
      console.log(
        `Hygiene: ${hygiene.mergedFactIds.length} fact(s) merged` +
          `${hygiene.mergedFactIds.length > 0 ? ` (${hygiene.mergedFactIds.join(", ")})` : ""}, ` +
          `${hygiene.contradictionsResolved.length} contradiction(s) resolved` +
          `${hygiene.contradictionsResolved.length > 0 ? ` (${hygiene.contradictionsResolved.join(", ")})` : ""}, ` +
          `${hygiene.episodesCompacted.length} episode(s) compacted, ` +
          `${hygiene.indexLinesDropped.length} index line(s) dropped`
      );
      for (const error of hygiene.errors) {
        console.error(`Hygiene issue: ${error}`);
      }

      if (result.failed.length > 0) {
        for (const failure of result.failed) {
          console.error(`Failed: ${failure.sessionId} — ${failure.error}`);
        }
        process.exit(1);
      }
    });

  command
    .command("forget <id>")
    .description("Move a fact or episode to archive/ and drop its index line")
    .action((id: string) => {
      ensureMemoryLayout();
      const archived = archiveMemoryEntry(id);
      if (!archived) {
        console.error(`No memory entry found with id "${id}".`);
        const known = listMemoryEntries()
          .map((item) => item.id)
          .join(", ");
        console.error(`Known ids: ${known || "(none)"}`);
        process.exit(1);
        return;
      }

      console.log(`Archived "${id}" → ${archived}`);
    });

  return command;
}
