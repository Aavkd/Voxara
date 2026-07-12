/**
 * Memory Store — file-based layered memory under ~/.llmtest/memory/.
 *
 * Phase M1 (docs/memory-architecture-spec.md): storage layout + read path.
 * Phase M2: curated writes (facts, episodes, index), archive moves, inbox
 * processing, and the consolidation registry under .state/.
 * Phase M3: hygiene primitives — fact/episode detail listing, dated archive
 * names, episode compaction into quarterly digests, index budget enforcement.
 *
 * Layout:
 *   MEMORY.md   Index, one line per memory. Injected into every conversation.
 *   facts/      Tier 3 — one Markdown file per durable fact.
 *   episodes/   Tier 2 — one Markdown file per consolidated past conversation.
 *   inbox/      Raw unprocessed notes awaiting consolidation.
 *   archive/    Soft-deleted / compacted material. Never loaded into prompts.
 *   .state/     Machine state (consolidation registry). Not user-facing.
 *
 * Everything is plain Markdown so the user can read and edit memory by hand;
 * hand-edited or unexpected files must never break these functions.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Message } from "../types";

export interface MemoryPaths {
  root: string;
  indexFile: string;
  factsDir: string;
  episodesDir: string;
  inboxDir: string;
  archiveDir: string;
  stateDir: string;
  registryFile: string;
}

export type MemoryEntryType = "fact" | "episode";

export interface MemoryEntry {
  id: string;
  type: MemoryEntryType;
  filePath: string;
}

/** Seed content for a brand-new MEMORY.md index. */
export const MEMORY_INDEX_SEED = [
  "# Memory Index",
  "",
  "<!-- One line per memory: - [id](facts/<id>.md) — short hook. Keep under 80 lines. -->",
  "",
  "## Facts",
  "",
  "## Recent episodes",
  "",
].join("\n");

/** Entry ids are kebab-case file stems — no separators, no traversal. */
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Hard budget for MEMORY.md (spec §3, §8.3). Enforced in code by
 * enforceMemoryIndexBudget after every hygiene pass — the single constant the
 * whole system shares.
 */
export const MEMORY_INDEX_MAX_LINES = 80;

/**
 * Resolve the memory directory paths.
 * Order: explicit argument, LLMTEST_MEMORY_DIR, then ~/.llmtest/memory.
 */
export function getMemoryPaths(baseDir?: string): MemoryPaths {
  const root = path.resolve(
    baseDir ||
      process.env.LLMTEST_MEMORY_DIR ||
      path.join(os.homedir(), ".llmtest", "memory")
  );

  return {
    root,
    indexFile: path.join(root, "MEMORY.md"),
    factsDir: path.join(root, "facts"),
    episodesDir: path.join(root, "episodes"),
    inboxDir: path.join(root, "inbox"),
    archiveDir: path.join(root, "archive"),
    stateDir: path.join(root, ".state"),
    registryFile: path.join(root, ".state", "consolidated.json"),
  };
}

/**
 * Create the memory directory layout and seed MEMORY.md if missing.
 * Idempotent — never overwrites existing files.
 */
export function ensureMemoryLayout(baseDir?: string): MemoryPaths {
  const paths = getMemoryPaths(baseDir);

  for (const dir of [
    paths.root,
    paths.factsDir,
    paths.episodesDir,
    paths.inboxDir,
    paths.archiveDir,
    paths.stateDir,
  ]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  if (!fs.existsSync(paths.indexFile)) {
    fs.writeFileSync(paths.indexFile, MEMORY_INDEX_SEED, "utf-8");
  }

  return paths;
}

/**
 * Read the MEMORY.md index. Returns "" when the file is missing or unreadable
 * — memory must never crash a conversation.
 */
export function readMemoryIndex(baseDir?: string): string {
  const paths = getMemoryPaths(baseDir);

  try {
    return fs.readFileSync(paths.indexFile, "utf-8");
  } catch {
    return "";
  }
}

/** True when the index contains at least one entry line ("- ..."). */
export function memoryIndexHasEntries(index: string): boolean {
  return index
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith("- "));
}

/**
 * List every fact and episode file, sorted by id within each type.
 * Non-Markdown files are ignored; a missing directory yields no entries.
 */
export function listMemoryEntries(baseDir?: string): MemoryEntry[] {
  const paths = getMemoryPaths(baseDir);

  const scan = (dir: string, type: MemoryEntryType): MemoryEntry[] => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }

    return names
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort()
      .map((name) => ({
        id: name.replace(/\.md$/i, ""),
        type,
        filePath: path.join(dir, name),
      }));
  };

  return [
    ...scan(paths.factsDir, "fact"),
    ...scan(paths.episodesDir, "episode"),
  ];
}

/**
 * Read one memory entry by id, looking in facts/ then episodes/.
 * Returns null for unknown ids and rejects ids that are not plain file stems
 * (path traversal is blocked; the model supplies these ids).
 */
export function readMemoryEntry(
  id: string,
  baseDir?: string
): { id: string; type: MemoryEntryType; content: string } | null {
  if (!ENTRY_ID_PATTERN.test(id) || id.includes("..")) {
    return null;
  }

  const paths = getMemoryPaths(baseDir);
  const candidates: Array<{ type: MemoryEntryType; filePath: string }> = [
    { type: "fact", filePath: path.join(paths.factsDir, `${id}.md`) },
    { type: "episode", filePath: path.join(paths.episodesDir, `${id}.md`) },
  ];

  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate.filePath, "utf-8");
      return { id, type: candidate.type, content };
    } catch {
      // Try the next location.
    }
  }

  return null;
}

/**
 * Append a raw note to inbox/ — the fast path of "remember that…".
 * Notes stay untouched until the memory agent consolidates them (Phase M2).
 * Returns the created file path.
 */
export function appendInboxNote(
  text: string,
  source: string,
  baseDir?: string
): string {
  const paths = ensureMemoryLayout(baseDir);

  const createdAt = new Date();
  const stamp = createdAt.toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomUUID().slice(0, 8);
  const filePath = path.join(paths.inboxDir, `${stamp}-${suffix}.md`);

  const note = [
    "---",
    `created: ${createdAt.toISOString()}`,
    `source: ${source}`,
    "---",
    "",
    text.trim(),
    "",
  ].join("\n");

  fs.writeFileSync(filePath, note, "utf-8");
  return filePath;
}

/** Number of raw notes waiting for consolidation. */
export function countInboxNotes(baseDir?: string): number {
  const paths = getMemoryPaths(baseDir);

  try {
    return fs
      .readdirSync(paths.inboxDir)
      .filter((name) => name.toLowerCase().endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/**
 * Explicit "remember this" phrasings, second-person only so the user talking
 * about their own memories ("je me souviens de…") does not trigger a note.
 * Over-capture is acceptable — the memory agent discards false positives at
 * consolidation (Phase M2) — but missing a genuine request is not.
 */
const REMEMBER_INTENT_PATTERNS: RegExp[] = [
  /\bretiens\b/i,
  /\bretenez\b/i,
  /\bretenir\s+que\b/i,
  /\brappelle[\s-]*toi\b/i,
  /\b(?:te|tu\s+te)\s+rappelle[sr]?\b/i,
  /\bsouviens[\s-]*toi\b/i,
  /\b(?:te|tu\s+te)\s+souvienne?s?\b/i,
  /\bn['’]?oublie[sz]?\s+pas\b/i,
  /\bm[ée]morise[sz]?\b/i,
  /\bgarde\s+(?:bien\s+)?(?:[çc]a\s+)?en\s+m[ée]moire\b/i,
  /\bnote\s+(?:bien\s+)?que\b/i,
  /\bremember\s+(?:that|this|my|to)\b/i,
  /\bdon['’]?t\s+forget\b/i,
  /\bkeep\s+in\s+mind\b/i,
];

/**
 * Detect an explicit "remember that…" request in a user utterance.
 * Used by plain voice mode, which has no tools: matching turns are copied raw
 * into inbox/ instead of going through the memory_note tool (spec §5.2).
 */
export function detectRememberIntent(text: string): boolean {
  return REMEMBER_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Build the memory section injected into conversation prompts.
 *
 * With `withToolInstructions`, the block also tells the model how to use the
 * memory_read / memory_note tools (agent modes only — plain chat has no
 * tools) and is emitted even when the index is empty, because the very first
 * "remember that…" happens before any memory exists. Without tool
 * instructions an empty index yields "" so empty memory costs no tokens.
 */
export function buildMemoryContextBlock(
  options: { withToolInstructions?: boolean; baseDir?: string } = {}
): string {
  const index = readMemoryIndex(options.baseDir);
  const hasEntries = memoryIndexHasEntries(index);
  if (!hasEntries && !options.withToolInstructions) {
    return "";
  }

  const lines = hasEntries
    ? [
        "Long-term memory — index of durable facts and past conversations about the user:",
        "",
        index.trim(),
        "",
        "Use this memory to personalize your answers. It may be incomplete or slightly out of date.",
      ]
    : ["Long-term memory: no entries yet."];

  if (options.withToolInstructions) {
    lines.push(
      "To read the full detail behind an index entry, call the memory_read tool with the entry id.",
      'When the user asks you to remember something ("retiens que…", "remember that…", "n\'oublie pas que…"), call the memory_note tool with the exact fact to remember, then confirm briefly.',
      "Durable preferences and standing instructions (for example how to address the user) also count: save them with memory_note too. Never claim you will remember something without calling memory_note."
    );
  }

  return lines.join("\n");
}

/**
 * Build the transient message pair that carries the memory context in chat
 * history without a system role. Prepend to the messages sent to the provider
 * — never persist it in the session file.
 */
export function buildMemoryPreambleMessages(
  options: { withToolInstructions?: boolean; baseDir?: string } = {}
): Message[] {
  const block = buildMemoryContextBlock(options);
  if (!block) {
    return [];
  }

  return [
    { role: "user", content: block, timestamp: Date.now() },
    {
      role: "model",
      content: "Understood. I will keep this long-term memory in mind.",
      timestamp: Date.now(),
    },
  ];
}

// ── Phase M2: curated write path ──────────────────────────────────────
//
// These functions are the ONLY way facts/, episodes/, and MEMORY.md get
// written (spec §5 invariant). They are called by the consolidation
// orchestrator, never by the conversational agent.

export interface InboxNote {
  fileName: string;
  filePath: string;
  content: string;
}

/** List pending inbox notes, oldest first (filenames are timestamped). */
export function listInboxNotes(baseDir?: string): InboxNote[] {
  const paths = getMemoryPaths(baseDir);

  let names: string[];
  try {
    names = fs.readdirSync(paths.inboxDir);
  } catch {
    return [];
  }

  const notes: InboxNote[] = [];
  for (const name of names.filter((n) => n.toLowerCase().endsWith(".md")).sort()) {
    const filePath = path.join(paths.inboxDir, name);
    try {
      notes.push({ fileName: name, filePath, content: fs.readFileSync(filePath, "utf-8") });
    } catch {
      // Unreadable note: leave it in place, skip it this run.
    }
  }
  return notes;
}

/**
 * Remove a processed inbox note by moving it to archive/ (spec §6.2: removal
 * always means archiving, never hard deletion). Returns true on success.
 */
export function archiveInboxNote(fileName: string, baseDir?: string): boolean {
  const paths = getMemoryPaths(baseDir);
  const source = path.join(paths.inboxDir, fileName);
  if (path.basename(fileName) !== fileName || !fs.existsSync(source)) {
    return false;
  }

  try {
    fs.mkdirSync(paths.archiveDir, { recursive: true });
    fs.renameSync(source, uniqueArchivePath(paths.archiveDir, `inbox-${fileName}`));
    return true;
  } catch {
    return false;
  }
}

/** Frontmatter parsed from a fact/episode file, plus its body. */
interface ParsedEntryFile {
  frontmatter: Array<{ key: string; value: string }>;
  body: string;
}

function parseEntryFile(content: string): ParsedEntryFile {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: [], body: content };
  }

  const frontmatter: Array<{ key: string; value: string }> = [];
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) {
      frontmatter.push({ key: kv[1], value: kv[2].trim() });
    }
  }
  return { frontmatter, body: content.slice(match[0].length) };
}

function serializeEntryFile(
  frontmatter: Array<{ key: string; value: string }>,
  body: string
): string {
  return [
    "---",
    ...frontmatter.map(({ key, value }) => `${key}: ${value}`),
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

/**
 * Create or update a fact file (spec §3.1 format). On update, the existing
 * `created:` date and any frontmatter keys this code does not manage are
 * preserved (spec §6.2: tolerate hand-edited files).
 */
export function upsertFactFile(
  id: string,
  body: string,
  source: string,
  baseDir?: string
): string | null {
  if (!ENTRY_ID_PATTERN.test(id) || id.includes("..")) {
    return null;
  }

  const paths = ensureMemoryLayout(baseDir);
  const filePath = path.join(paths.factsDir, `${id}.md`);
  const today = new Date().toISOString().slice(0, 10);

  const managed: Record<string, string> = {
    id,
    type: "fact",
    created: today,
    updated: today,
    source,
  };

  let extraKeys: Array<{ key: string; value: string }> = [];
  if (fs.existsSync(filePath)) {
    try {
      const existing = parseEntryFile(fs.readFileSync(filePath, "utf-8"));
      const created = existing.frontmatter.find((f) => f.key === "created");
      if (created?.value) {
        managed.created = created.value;
      }
      extraKeys = existing.frontmatter.filter(
        (f) => !["id", "type", "created", "updated", "source"].includes(f.key)
      );
    } catch {
      // Unreadable existing file: overwrite with the fresh version.
    }
  }

  const frontmatter = [
    ...Object.entries(managed).map(([key, value]) => ({ key, value })),
    ...extraKeys,
  ];
  fs.writeFileSync(filePath, serializeEntryFile(frontmatter, body), "utf-8");
  return filePath;
}

export interface EpisodeContent {
  sessionId: string;
  date: string;
  source: string;
  summary: string;
  decisions: string[];
  openThreads: string[];
}

/**
 * Write (or overwrite — that is what makes re-consolidation idempotent) an
 * episode file with the fixed Summary / Decisions / Open threads shape.
 */
export function writeEpisodeFile(
  id: string,
  episode: EpisodeContent,
  baseDir?: string
): string | null {
  if (!ENTRY_ID_PATTERN.test(id) || id.includes("..")) {
    return null;
  }

  const paths = ensureMemoryLayout(baseDir);
  const filePath = path.join(paths.episodesDir, `${id}.md`);
  const today = new Date().toISOString().slice(0, 10);

  const frontmatter = [
    { key: "id", value: id },
    { key: "type", value: "episode" },
    { key: "session_id", value: episode.sessionId },
    { key: "date", value: episode.date },
    { key: "created", value: today },
    { key: "updated", value: today },
    { key: "source", value: episode.source },
  ];

  const listOrNone = (items: string[]): string =>
    items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "(none)";

  const body = [
    "## Summary",
    "",
    episode.summary.trim(),
    "",
    "## Decisions",
    "",
    listOrNone(episode.decisions),
    "",
    "## Open threads",
    "",
    listOrNone(episode.openThreads),
  ].join("\n");

  fs.writeFileSync(filePath, serializeEntryFile(frontmatter, body), "utf-8");
  return filePath;
}

/**
 * Soft-delete a fact or episode: move its file to archive/ and drop its index
 * line. Returns the archived file path, or null when the id is unknown.
 * `datedFileName` archives as `<id>-<yyyy-mm-dd>.md` — spec §8.3 requires it
 * for contradiction losers so successive versions stay distinguishable.
 */
export function archiveMemoryEntry(
  id: string,
  baseDir?: string,
  options: { datedFileName?: boolean } = {}
): string | null {
  if (!ENTRY_ID_PATTERN.test(id) || id.includes("..")) {
    return null;
  }

  const paths = ensureMemoryLayout(baseDir);
  const candidates = [
    path.join(paths.factsDir, `${id}.md`),
    path.join(paths.episodesDir, `${id}.md`),
  ];

  const archiveName = options.datedFileName
    ? `${id}-${new Date().toISOString().slice(0, 10)}.md`
    : `${id}.md`;

  for (const source of candidates) {
    if (!fs.existsSync(source)) {
      continue;
    }
    try {
      const target = uniqueArchivePath(paths.archiveDir, archiveName);
      fs.renameSync(source, target);
      updateMemoryIndex({ removeIds: [id] }, baseDir);
      return target;
    } catch {
      return null;
    }
  }

  return null;
}

function uniqueArchivePath(archiveDir: string, fileName: string): string {
  const direct = path.join(archiveDir, fileName);
  if (!fs.existsSync(direct)) {
    return direct;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = fileName.replace(/\.md$/i, "");
  return path.join(archiveDir, `${base}-${stamp}.md`);
}

export interface IndexUpdate {
  /** Fact lines to add or refresh under "## Facts". */
  factEntries?: Array<{ id: string; hook: string }>;
  /** Episode lines to add or refresh under "## Recent episodes" (newest first). */
  episodeEntries?: Array<{ id: string; hook: string }>;
  /** Ids whose lines must disappear (archived facts/episodes). */
  removeIds?: string[];
}

/**
 * Update MEMORY.md line-by-line: existing lines for the affected ids are
 * replaced, everything else (hand-written lines included) is left untouched.
 * Missing section headers are recreated at the end of the file.
 */
export function updateMemoryIndex(update: IndexUpdate, baseDir?: string): void {
  const paths = ensureMemoryLayout(baseDir);

  let content: string;
  try {
    content = fs.readFileSync(paths.indexFile, "utf-8");
  } catch {
    content = MEMORY_INDEX_SEED;
  }

  const affectedIds = [
    ...(update.factEntries ?? []).map((entry) => entry.id),
    ...(update.episodeEntries ?? []).map((entry) => entry.id),
    ...(update.removeIds ?? []),
  ];

  let lines = content.split(/\r?\n/);
  if (affectedIds.length > 0) {
    const idPatterns = affectedIds.map(
      (id) => new RegExp(`\\((?:facts|episodes)/${escapeRegExp(id)}\\.md\\)`)
    );
    lines = lines.filter((line) => !idPatterns.some((pattern) => pattern.test(line)));
  }

  const factLines = (update.factEntries ?? []).map(
    (entry) => `- [${entry.id}](facts/${entry.id}.md) — ${entry.hook}`
  );
  const episodeLines = (update.episodeEntries ?? []).map(
    (entry) => `- [${entry.id}](episodes/${entry.id}.md) — ${entry.hook}`
  );

  lines = insertUnderHeader(lines, "## Facts", factLines, "append");
  lines = insertUnderHeader(lines, "## Recent episodes", episodeLines, "prepend");

  fs.writeFileSync(paths.indexFile, lines.join("\n"), "utf-8");
}

/**
 * Insert lines into the section that starts at `header`. "append" places them
 * at the end of the section (facts accumulate), "prepend" right under the
 * header (newest episode first). The header is created when missing.
 */
function insertUnderHeader(
  lines: string[],
  header: string,
  newLines: string[],
  position: "append" | "prepend"
): string[] {
  if (newLines.length === 0) {
    return lines;
  }

  let headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex === -1) {
    const result = [...lines];
    if (result.length > 0 && result[result.length - 1].trim() !== "") {
      result.push("");
    }
    result.push(header, "", ...newLines, "");
    return result;
  }

  let insertAt: number;
  if (position === "prepend") {
    insertAt = headerIndex + 1;
    while (insertAt < lines.length && lines[insertAt].trim() === "") {
      insertAt += 1;
    }
  } else {
    insertAt = lines.length;
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      if (lines[i].trim().startsWith("## ")) {
        insertAt = i;
        break;
      }
    }
    while (insertAt > headerIndex + 1 && lines[insertAt - 1].trim() === "") {
      insertAt -= 1;
    }
  }

  return [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Consolidation registry (spec §5.1 "consolidated marker") ─────────

export interface ConsolidationRegistryEntry {
  consolidatedAt: string;
  messageCount: number;
}

export type ConsolidationRegistry = Record<string, ConsolidationRegistryEntry>;

/** Read the registry; a missing or corrupt file yields an empty registry. */
export function readConsolidationRegistry(baseDir?: string): ConsolidationRegistry {
  const paths = getMemoryPaths(baseDir);

  try {
    const parsed = JSON.parse(fs.readFileSync(paths.registryFile, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ConsolidationRegistry;
    }
  } catch {
    // Fall through to empty registry.
  }
  return {};
}

/** Record that a session transcript has been consolidated at its current size. */
export function markSessionConsolidated(
  sessionId: string,
  messageCount: number,
  baseDir?: string
): void {
  const paths = ensureMemoryLayout(baseDir);
  const registry = readConsolidationRegistry(baseDir);
  registry[sessionId] = {
    consolidatedAt: new Date().toISOString(),
    messageCount,
  };
  fs.writeFileSync(paths.registryFile, JSON.stringify(registry, null, 2), "utf-8");
}

/**
 * True when the session has already been consolidated at this message count —
 * the idempotence check for re-runs and resumed-then-exited sessions.
 */
export function isSessionConsolidated(
  sessionId: string,
  messageCount: number,
  baseDir?: string
): boolean {
  const entry = readConsolidationRegistry(baseDir)[sessionId];
  return entry !== undefined && entry.messageCount === messageCount;
}

// ── Phase M3: hygiene primitives (spec §8.3) ──────────────────────────
//
// Deterministic file-level operations used by the hygiene pass in
// src/memory/hygiene.ts. Guardrails stay here: archive instead of delete,
// hand-edited content preserved, unknown files left untouched.

/** One fact with its parsed dates and body — hygiene agent input. */
export interface FactDetails {
  id: string;
  filePath: string;
  body: string;
  created: string;
  updated: string;
}

/**
 * List every fact with its full body and frontmatter dates. Unreadable files
 * are skipped; missing frontmatter keys yield empty strings.
 */
export function listFactDetails(baseDir?: string): FactDetails[] {
  const details: FactDetails[] = [];

  for (const entry of listMemoryEntries(baseDir)) {
    if (entry.type !== "fact") {
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(entry.filePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseEntryFile(content);
    const value = (key: string): string =>
      parsed.frontmatter.find((item) => item.key === key)?.value ?? "";
    details.push({
      id: entry.id,
      filePath: entry.filePath,
      body: parsed.body.trim(),
      created: value("created"),
      updated: value("updated"),
    });
  }

  return details;
}

export interface EpisodeCompactionResult {
  /** Episode ids moved to archive/ after being folded into a digest. */
  compactedIds: string[];
  /** Digest ids created or extended (compacted-<yyyy-qN>). */
  digestIds: string[];
}

/** Episode date: frontmatter `date:`, else `created:`, else the id prefix. */
function resolveEpisodeDate(id: string, parsed: ParsedEntryFile): string | null {
  const fromKey = (key: string): string | null => {
    const value = parsed.frontmatter.find((item) => item.key === key)?.value ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  };
  const fromId = id.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  return fromKey("date") ?? fromKey("created") ?? fromId;
}

/** First meaningful line under "## Summary", else the first body line. */
function firstSummaryLine(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const summaryAt = lines.findIndex((line) => /^##\s+summary/i.test(line));
  const candidates = summaryAt >= 0 ? lines.slice(summaryAt + 1) : lines;
  for (const line of candidates) {
    if (line && !line.startsWith("#")) {
      return line;
    }
  }
  return "(no summary)";
}

/**
 * Compact episodes older than `retentionDays` into per-quarter digest files
 * `episodes/compacted-<yyyy-qN>.md` (spec §8.3). Originals move to archive/
 * and lose their index line; each digest gets one index line instead.
 *
 * Idempotent and hand-edit tolerant: digests are appended to (one bullet per
 * episode id, deduplicated), never rewritten wholesale; episodes without a
 * parseable date are left untouched.
 */
export function compactOldEpisodes(
  retentionDays: number,
  baseDir?: string
): EpisodeCompactionResult {
  const result: EpisodeCompactionResult = { compactedIds: [], digestIds: [] };
  const paths = ensureMemoryLayout(baseDir);

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const groups = new Map<string, Array<{ id: string; date: string; summary: string }>>();
  for (const entry of listMemoryEntries(baseDir)) {
    if (entry.type !== "episode" || entry.id.startsWith("compacted-")) {
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(entry.filePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseEntryFile(content);
    const date = resolveEpisodeDate(entry.id, parsed);
    if (!date || date >= cutoff) {
      continue;
    }
    const quarter = `${date.slice(0, 4)}-q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
    const group = groups.get(quarter) ?? [];
    group.push({ id: entry.id, date, summary: firstSummaryLine(parsed.body) });
    groups.set(quarter, group);
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const [quarter, episodes] of groups) {
    const digestId = `compacted-${quarter}`;
    const digestPath = path.join(paths.episodesDir, `${digestId}.md`);

    let digest: string;
    if (fs.existsSync(digestPath)) {
      try {
        digest = fs.readFileSync(digestPath, "utf-8");
      } catch {
        continue; // Unreadable digest: leave this quarter alone this run.
      }
    } else {
      digest = serializeEntryFile(
        [
          { key: "id", value: digestId },
          { key: "type", value: "episode" },
          { key: "created", value: today },
          { key: "updated", value: today },
          { key: "source", value: "episode compaction" },
        ],
        `# Compacted episodes — ${quarter}\n\nOne line per archived episode (full text in archive/).`
      );
    }

    const compactedNow: string[] = [];
    for (const episode of episodes.sort((a, b) => a.date.localeCompare(b.date))) {
      if (!digest.includes(`(${episode.id})`)) {
        digest = `${digest.trimEnd()}\n- ${episode.date} — ${episode.summary} (${episode.id})`;
      }
      compactedNow.push(episode.id);
    }

    try {
      fs.writeFileSync(digestPath, `${digest.trimEnd()}\n`, "utf-8");
    } catch {
      continue;
    }

    for (const id of compactedNow) {
      // archiveMemoryEntry also drops the episode's index line.
      if (archiveMemoryEntry(id, baseDir)) {
        result.compactedIds.push(id);
      }
    }
    updateMemoryIndex(
      {
        episodeEntries: [
          { id: digestId, hook: `compacted digest of ${quarter} episodes` },
        ],
      },
      baseDir
    );
    result.digestIds.push(digestId);
  }

  return result;
}

export interface IndexBudgetResult {
  /** Episode ids whose index lines were dropped (files stay in episodes/). */
  droppedEpisodeIds: string[];
  /** Still over MEMORY_INDEX_MAX_LINES after dropping every episode line. */
  overBudget: boolean;
}

/**
 * Enforce the MEMORY.md hard budget (spec §8.3): when the file exceeds
 * MEMORY_INDEX_MAX_LINES, the oldest plain-episode lines drop first (bottom of
 * "Recent episodes" — the section is newest-first). Compacted digests and fact
 * lines are never dropped by code; a remaining overflow is reported so the
 * hygiene agent can be asked to merge facts more aggressively.
 */
export function enforceMemoryIndexBudget(baseDir?: string): IndexBudgetResult {
  const result: IndexBudgetResult = { droppedEpisodeIds: [], overBudget: false };
  const paths = ensureMemoryLayout(baseDir);

  let content: string;
  try {
    content = fs.readFileSync(paths.indexFile, "utf-8");
  } catch {
    return result;
  }

  const lines = content.split(/\r?\n/);
  if (lines.length <= MEMORY_INDEX_MAX_LINES) {
    return result;
  }

  const episodeLinePattern = /^- \[([^\]]+)\]\(episodes\/[^)]+\.md\)/;
  while (lines.length > MEMORY_INDEX_MAX_LINES) {
    let dropIndex = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const match = lines[i].trim().match(episodeLinePattern);
      if (match && !match[1].startsWith("compacted-")) {
        dropIndex = i;
        result.droppedEpisodeIds.push(match[1]);
        break;
      }
    }
    if (dropIndex === -1) {
      break;
    }
    lines.splice(dropIndex, 1);
  }

  result.overBudget = lines.length > MEMORY_INDEX_MAX_LINES;
  if (result.droppedEpisodeIds.length > 0) {
    fs.writeFileSync(paths.indexFile, lines.join("\n"), "utf-8");
  }
  return result;
}
