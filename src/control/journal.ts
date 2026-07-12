import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ensureStateDir } from "../engine/statePaths";
import { ControlJournalEntry, ScreenImageResult } from "./types";

const DEFAULT_CAPTURE_KEEP_COUNT = 5;

export function journalScreenView(
  entry: Omit<ControlJournalEntry, "timestamp" | "lane" | "intent" | "policyDecision">,
  image?: ScreenImageResult,
  baseDir?: string
): void {
  const state = ensureStateDir(baseDir);
  const controlDir = path.join(state.root, "control");
  fs.mkdirSync(controlDir, { recursive: true });
  pruneExpiredState(controlDir, retentionDays());

  let artifact: string | undefined;
  if (image && entry.outcome === "success") {
    const sessionDir = path.join(controlDir, safeSegment(entry.sessionId), "captures");
    fs.mkdirSync(sessionDir, { recursive: true });
    artifact = path.join(
      sessionDir,
      `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}.png`
    );
    fs.writeFileSync(artifact, Buffer.from(image.base64, "base64"));
    pruneCaptures(sessionDir, DEFAULT_CAPTURE_KEEP_COUNT);
  }

  const record: ControlJournalEntry = {
    timestamp: new Date().toISOString(),
    lane: "fast",
    intent: "screen_view",
    policyDecision: "allowed",
    ...entry,
    artifact,
  };
  fs.appendFileSync(
    path.join(controlDir, `${safeSegment(entry.sessionId)}.jsonl`),
    `${JSON.stringify(record)}\n`,
    "utf8"
  );
}

function retentionDays(): number {
  const value = Number(process.env.CONTROL_JOURNAL_RETENTION_DAYS);
  return Number.isInteger(value) && value > 0 ? value : 30;
}

function pruneExpiredState(controlDir: string, days: number): void {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(controlDir, { withFileTypes: true })) {
    const item = path.join(controlDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      if (fs.statSync(item).mtimeMs < cutoff) fs.rmSync(item, { force: true });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const captureDir = path.join(item, "captures");
    if (!fs.existsSync(captureDir)) continue;
    for (const capture of fs.readdirSync(captureDir)) {
      const file = path.join(captureDir, capture);
      if (capture.endsWith(".png") && fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
      }
    }
  }
}

function pruneCaptures(directory: string, keep: number): void {
  const files = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".png"))
    .map((name) => ({ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(keep)) {
    fs.rmSync(path.join(directory, file.name), { force: true });
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unscoped";
}
