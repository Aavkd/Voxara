/**
 * Consolidation — turns finished conversations into episodes and facts
 * (spec §5.1, §6, §8.2).
 *
 * One run: gather unconsolidated inputs → call the memory agent → apply its
 * plan through memoryStore operations → update the registry. Guardrails are
 * enforced HERE, never trusted to the model: writes stay under the memory
 * root, removal means archiving, malformed plans change nothing on disk.
 *
 * Triggers: /exit in the conversational commands (with a hard timeout), the
 * fire-and-forget startup catch-up sweep, and `llmtest memory consolidate`.
 * There are no timers, and nothing here runs inside the voice loop.
 */

import * as fs from "fs";
import * as path from "path";
import { AppConfig, Message, messageText } from "../types";
import { ILLMProvider } from "../providers/ILLMProvider";
import { createProvider } from "../providers/factory";
import {
  loadConfig,
  loadEpisodeRetentionDays,
  loadMemoryAgentConfig,
} from "../config/loader";
import {
  loadAgentSession,
  loadSession,
  getVoiceSessionDir,
} from "../session/session";
import {
  archiveInboxNote,
  archiveMemoryEntry,
  ensureMemoryLayout,
  isSessionConsolidated,
  listInboxNotes,
  listMemoryEntries,
  markSessionConsolidated,
  readMemoryEntry,
  readMemoryIndex,
  updateMemoryIndex,
  upsertFactFile,
  writeEpisodeFile,
} from "./memoryStore";
import { MemoryAgentPlan, runMemoryAgent } from "./memoryAgent";
import { HygieneResult, runHygiene } from "./hygiene";

/** One finished conversation waiting to be consolidated. */
export interface SessionInput {
  sessionId: string;
  channel: "text chat" | "agent chat" | "voice";
  /** yyyy-mm-dd of the session start. */
  date: string;
  transcript: string;
  messageCount: number;
}

export interface ConsolidationResult {
  consolidated: string[];
  skipped: string[];
  failed: Array<{ sessionId: string; error: string }>;
  factsWritten: string[];
  archivedIds: string[];
  inboxProcessed: number;
  /** Phase M3: outcome of the hygiene step that ends every run. */
  hygiene: HygieneResult;
}

export interface ConsolidationOptions {
  /** Injected provider (tests); otherwise resolved from config. */
  provider?: ILLMProvider;
  /** Main-session config used to derive the memory agent's provider/model. */
  config?: AppConfig;
  /** Memory root override (tests). */
  baseDir?: string;
  /** Explicit inputs (tests, targeted runs); otherwise gathered from disk. */
  sessions?: SessionInput[];
  /** Session ids that are live right now and must not be consolidated. */
  excludeSessionIds?: string[];
  /**
   * Force the full hygiene pass (LLM merge/contradiction analysis) even when
   * this run changed nothing — `memory consolidate --deep`.
   */
  deep?: boolean;
  /** Episode retention override (tests); defaults to config/90 days. */
  retentionDays?: number;
  log?: (message: string) => void;
}

/** Keep prompts bounded: very long transcripts keep only their tail. */
const MAX_TRANSCRIPT_CHARS = 16000;

/** Episode id = <yyyy-mm-dd>-<first 8 chars of session id> (spec §8.2). */
export function episodeIdFor(sessionId: string, date: string): string {
  const idPart = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return `${date}-${idPart || "session"}`;
}

/**
 * Run one consolidation pass. Never throws — every failure degrades to a
 * result entry so callers in the conversational hot path stay safe.
 */
export async function runConsolidation(
  options: ConsolidationOptions = {}
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    consolidated: [],
    skipped: [],
    failed: [],
    factsWritten: [],
    archivedIds: [],
    inboxProcessed: 0,
    hygiene: {
      mergedFactIds: [],
      rewrittenFactIds: [],
      contradictionsResolved: [],
      episodesCompacted: [],
      indexLinesDropped: [],
      errors: [],
    },
  };
  const log = options.log ?? (() => undefined);

  // Provider creation is lazy: a run with nothing pending and a clean memory
  // directory must not require LLM credentials at all.
  let provider: ILLMProvider | null = options.provider ?? null;
  const getProvider = (): ILLMProvider => {
    if (!provider) {
      provider = createMemoryAgentProvider(options.config);
    }
    return provider;
  };

  try {
    ensureMemoryLayout(options.baseDir);

    const excluded = new Set(options.excludeSessionIds ?? []);
    const allSessions = options.sessions ?? gatherSessionInputs();
    const pending: SessionInput[] = [];

    for (const session of allSessions) {
      if (excluded.has(session.sessionId)) {
        continue;
      }
      if (isSessionConsolidated(session.sessionId, session.messageCount, options.baseDir)) {
        result.skipped.push(session.sessionId);
        continue;
      }
      if (session.messageCount === 0 || !session.transcript.trim()) {
        // Nothing to remember; mark it so the sweep stops rescanning it.
        markSessionConsolidated(session.sessionId, session.messageCount, options.baseDir);
        result.skipped.push(session.sessionId);
        continue;
      }
      pending.push(session);
    }

    const inboxNotes = listInboxNotes(options.baseDir);

    // Inbox notes ride along with the first agent call; when no session is
    // pending they get a dedicated inbox-only call (episode: null). With
    // nothing pending at all, the main loop is skipped and only the hygiene
    // step below runs.
    const runs: Array<{ session: SessionInput | null; withInbox: boolean }> =
      pending.length > 0
        ? pending.map((session, index) => ({ session, withInbox: index === 0 }))
        : inboxNotes.length > 0
          ? [{ session: null, withInbox: true }]
          : [];

    for (const run of runs) {
      const sessionId = run.session?.sessionId ?? "(inbox only)";
      const includeInbox = run.withInbox && inboxNotes.length > 0;

      const agentResult = await runMemoryAgent(getProvider(), {
        date: run.session?.date ?? new Date().toISOString().slice(0, 10),
        channel: run.session?.channel ?? "inbox",
        transcript: run.session ? truncateTranscript(run.session.transcript) : "",
        memoryIndex: readMemoryIndex(options.baseDir),
        factSummaries: buildFactSummaries(options.baseDir),
        inboxNotes: includeInbox
          ? inboxNotes.map((note) => `--- note: ${note.fileName} ---\n${note.content.trim()}`).join("\n\n")
          : "(none)",
      });

      if (!agentResult.plan) {
        // Malformed plan: nothing was written, the session stays pending.
        result.failed.push({ sessionId, error: agentResult.error ?? "unknown error" });
        log(`memory: consolidation of ${sessionId} failed — ${agentResult.error}`);
        continue;
      }

      applyPlan(agentResult.plan, run.session, options.baseDir, result);

      if (run.session) {
        markSessionConsolidated(run.session.sessionId, run.session.messageCount, options.baseDir);
        result.consolidated.push(run.session.sessionId);
      }

      if (includeInbox) {
        for (const note of inboxNotes) {
          if (archiveInboxNote(note.fileName, options.baseDir)) {
            result.inboxProcessed += 1;
          }
        }
      }
    }

    // Phase M3: hygiene ends every run. The LLM merge/contradiction pass only
    // runs when this run changed facts (or --deep forces it); episode
    // compaction and the index budget are cheap code and always run.
    result.hygiene = await runHygiene({
      getProvider,
      withAgentPass: options.deep === true || result.factsWritten.length > 0,
      retentionDays: options.retentionDays ?? loadEpisodeRetentionDays(),
      baseDir: options.baseDir,
      log,
    });
  } catch (err) {
    // Memory must never crash a conversation (spec §8.0).
    result.failed.push({
      sessionId: "(run)",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

/**
 * Apply a validated plan through memoryStore operations only. Ids the plan
 * invents that do not exist are ignored for archiving; episode identity is
 * derived in code, never taken from the model.
 */
function applyPlan(
  plan: MemoryAgentPlan,
  session: SessionInput | null,
  baseDir: string | undefined,
  result: ConsolidationResult
): void {
  const factEntries: Array<{ id: string; hook: string }> = [];
  for (const upsert of plan.factUpserts) {
    const source = session
      ? `${session.channel} session ${session.date}`
      : `inbox consolidation ${new Date().toISOString().slice(0, 10)}`;
    if (upsertFactFile(upsert.id, upsert.body, source, baseDir)) {
      factEntries.push({ id: upsert.id, hook: upsert.hook });
      result.factsWritten.push(upsert.id);
    }
  }

  const episodeEntries: Array<{ id: string; hook: string }> = [];
  if (plan.episode && session) {
    const id = episodeIdFor(session.sessionId, session.date);
    const written = writeEpisodeFile(
      id,
      {
        sessionId: session.sessionId,
        date: session.date,
        source: `${session.channel} session ${session.date}`,
        summary: plan.episode.summary,
        decisions: plan.episode.decisions,
        openThreads: plan.episode.openThreads,
      },
      baseDir
    );
    if (written) {
      episodeEntries.push({ id, hook: plan.episode.hook });
    }
  }

  if (factEntries.length > 0 || episodeEntries.length > 0) {
    updateMemoryIndex({ factEntries, episodeEntries }, baseDir);
  }

  for (const id of plan.archiveIds) {
    // archiveMemoryEntry validates the id and only moves existing entries —
    // an id the model hallucinated is a silent no-op.
    if (archiveMemoryEntry(id, baseDir)) {
      result.archivedIds.push(id);
    }
  }
}

// ── Input gathering ───────────────────────────────────────────────────

/**
 * Collect every consolidatable transcript on disk: the rolling text and agent
 * chat sessions plus one entry per voice JSONL log. When a voice log and
 * session.json share an id (voice sessions write both), the JSONL wins — it
 * is the richer record.
 */
export function gatherSessionInputs(): SessionInput[] {
  const inputs: SessionInput[] = [];
  const seen = new Set<string>();

  for (const filePath of listVoiceSessionFiles()) {
    const parsed = parseVoiceSessionFile(filePath);
    if (parsed && !seen.has(parsed.sessionId)) {
      seen.add(parsed.sessionId);
      inputs.push(parsed);
    }
  }

  const textSession = loadSession();
  if (textSession && !seen.has(textSession.id)) {
    seen.add(textSession.id);
    inputs.push({
      sessionId: textSession.id,
      channel: "text chat",
      date: new Date(textSession.createdAt).toISOString().slice(0, 10),
      transcript: formatMessages(textSession.messages),
      messageCount: textSession.messages.length,
    });
  }

  const agentSession = loadAgentSession();
  if (agentSession && !seen.has(agentSession.id)) {
    seen.add(agentSession.id);
    inputs.push({
      sessionId: agentSession.id,
      channel: "agent chat",
      date: new Date(agentSession.createdAt).toISOString().slice(0, 10),
      transcript: formatMessages(agentSession.messages),
      messageCount: agentSession.messages.length,
    });
  }

  return inputs;
}

function listVoiceSessionFiles(): string[] {
  try {
    const dir = getVoiceSessionDir();
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Rebuild a conversation from a voice JSONL log. Only final events matter:
 * final_transcript (user), assistant_final (assistant), and memory_note
 * (tells the agent which facts were already captured in the inbox).
 */
export function parseVoiceSessionFile(filePath: string): SessionInput | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let sessionId = "";
  let createdAt = 0;
  const lines: string[] = [];
  let messageCount = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event: { sessionId?: string; timestamp?: number; type?: string; text?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && typeof event.sessionId === "string") {
      sessionId = event.sessionId;
      createdAt = typeof event.timestamp === "number" ? event.timestamp : Date.now();
    }

    if (event.type === "final_transcript" && event.text) {
      lines.push(`User: ${event.text}`);
      messageCount += 1;
    } else if (event.type === "assistant_final" && event.text) {
      lines.push(`Assistant: ${event.text}`);
      messageCount += 1;
    } else if (event.type === "memory_note" && event.text) {
      lines.push(`[Remember request already captured in inbox: ${event.text}]`);
    }
  }

  if (!sessionId) {
    return null;
  }

  return {
    sessionId,
    channel: "voice",
    date: new Date(createdAt).toISOString().slice(0, 10),
    transcript: lines.join("\n"),
    messageCount,
  };
}

/**
 * Flatten chat messages to "User:/Assistant:" lines. Plain voice turns wrap
 * the transcript in an instruction preamble; only the transcript survives.
 */
export function formatMessages(messages: Message[]): string {
  return messages
    .map((message) => {
      let content = messageText(message);
      const wrapped = content.match(/^Voice conversation instructions:[\s\S]*?User transcript:\r?\n([\s\S]*)$/);
      if (wrapped) {
        content = wrapped[1];
      }
      return `${message.role === "user" ? "User" : "Assistant"}: ${content.trim()}`;
    })
    .join("\n");
}

function truncateTranscript(transcript: string): string {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) {
    return transcript;
  }
  return `[transcript truncated — showing the most recent part]\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
}

function buildFactSummaries(baseDir?: string): string {
  return listMemoryEntries(baseDir)
    .filter((entry) => entry.type === "fact")
    .map((entry) => {
      const content = readMemoryEntry(entry.id, baseDir)?.content ?? "";
      const body = content.replace(/^---[\s\S]*?---\r?\n?/, "").trim();
      const firstLine = body.split(/\r?\n/)[0] ?? "";
      return `- ${entry.id}: ${firstLine}`;
    })
    .join("\n");
}

function createMemoryAgentProvider(config?: AppConfig): ILLMProvider {
  const mainConfig = config ?? loadConfig();
  return createProvider(loadMemoryAgentConfig(mainConfig));
}

// ── Trigger helpers ───────────────────────────────────────────────────

/** Hard budget for the /exit consolidation; past it, the sweep takes over. */
const EXIT_CONSOLIDATION_TIMEOUT_MS = 30000;

/**
 * /exit trigger: consolidate everything pending with a console notice and a
 * hard timeout. On timeout the session simply stays unconsolidated — the
 * next startup sweep catches it. Never throws.
 */
export async function consolidateOnExit(
  config: AppConfig,
  options: { baseDir?: string } = {}
): Promise<void> {
  console.log("Consolidating memory…");

  try {
    const result = await Promise.race([
      runConsolidation({ config, baseDir: options.baseDir }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), EXIT_CONSOLIDATION_TIMEOUT_MS).unref?.()
      ),
    ]);

    if (result === null) {
      console.log("Memory consolidation timed out — it will finish on the next launch.");
      return;
    }

    const parts: string[] = [];
    if (result.consolidated.length > 0) {
      parts.push(`${result.consolidated.length} session(s) consolidated`);
    }
    if (result.factsWritten.length > 0) {
      parts.push(`${result.factsWritten.length} fact(s) updated`);
    }
    if (result.inboxProcessed > 0) {
      parts.push(`${result.inboxProcessed} inbox note(s) filed`);
    }
    const cleaned =
      result.hygiene.mergedFactIds.length +
      result.hygiene.contradictionsResolved.length +
      result.hygiene.episodesCompacted.length;
    if (cleaned > 0) {
      parts.push(`${cleaned} entrie(s) tidied by hygiene`);
    }
    if (result.failed.length > 0) {
      parts.push(`${result.failed.length} failed (will retry next launch)`);
    }
    console.log(parts.length > 0 ? `Memory: ${parts.join(", ")}.` : "Memory: nothing to consolidate.");
  } catch {
    // Exiting must never fail because of memory work.
  }
}

/**
 * Startup catch-up sweep (spec §5.1): fire-and-forget, silent, never awaited
 * before the conversation starts and never allowed to surface a failure.
 */
export function startConsolidationSweep(
  config: AppConfig,
  excludeSessionIds: string[] = []
): void {
  void runConsolidation({ config, excludeSessionIds }).catch(() => undefined);
}
