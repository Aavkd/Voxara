/**
 * Hygiene — Phase M3 (docs/memory-architecture-spec.md §8.3).
 *
 * Runs as an extra step of every consolidation (and `memory consolidate
 * --deep` forces the full pass). Keeps memory quality high as volume grows:
 *
 *   1. Agent pass (LLM): merge duplicate facts, flag contradictions.
 *      Contradictions resolve in CODE — newest `updated:` wins, losers move
 *      to archive/ with a dated filename.
 *   2. Episode compaction (code): episodes older than the retention window
 *      fold into quarterly digests.
 *   3. Index budget (code): MEMORY.md hard cap, oldest episode lines drop
 *      first; if the index is still over budget, one extra aggressive-merge
 *      agent pass runs.
 *
 * All M2 guardrails apply: writes only through memoryStore, archive instead
 * of delete, malformed plans change nothing, hand-edited files tolerated.
 * Like all memory work, a hygiene failure must never crash anything.
 */

import { ILLMProvider } from "../providers/ILLMProvider";
import { MemoryHygienePlan, runHygieneAgent } from "./memoryAgent";
import {
  FactDetails,
  archiveMemoryEntry,
  compactOldEpisodes,
  enforceMemoryIndexBudget,
  listFactDetails,
  readMemoryIndex,
  updateMemoryIndex,
  upsertFactFile,
} from "./memoryStore";

export interface HygieneResult {
  /** Fact ids absorbed into another fact and archived. */
  mergedFactIds: string[];
  /** Fact ids whose body was rewritten as a merge target. */
  rewrittenFactIds: string[];
  /** Contradiction losers archived (dated filenames). */
  contradictionsResolved: string[];
  /** Episode ids folded into quarterly digests. */
  episodesCompacted: string[];
  /** Episode ids whose index line was dropped for the budget. */
  indexLinesDropped: string[];
  /** Non-fatal problems (failed agent pass, unavailable provider, …). */
  errors: string[];
}

export interface HygieneOptions {
  /**
   * Lazy provider factory — hygiene only pays for provider creation when it
   * actually needs an LLM call. May throw; that degrades to an error entry.
   */
  getProvider?: () => ILLMProvider;
  /** Run the LLM merge/contradiction pass (deep runs, or facts changed). */
  withAgentPass: boolean;
  /** Episodes older than this many days are compacted (spec §8.3). */
  retentionDays: number;
  baseDir?: string;
  log?: (message: string) => void;
}

/** Keep the hygiene prompt bounded even with unusually long fact bodies. */
const MAX_FACT_BODY_CHARS = 2000;

const OVER_BUDGET_NOTE =
  "IMPORTANT: The memory index is over its 80-line budget even after " +
  "compacting old episodes. Merge aggressively: combine every group of " +
  "related facts into a single fact so the number of index lines shrinks.";

/**
 * Run one hygiene pass. Never throws — every failure degrades to an entry in
 * `errors` and the remaining steps still run.
 */
export async function runHygiene(options: HygieneOptions): Promise<HygieneResult> {
  const result: HygieneResult = {
    mergedFactIds: [],
    rewrittenFactIds: [],
    contradictionsResolved: [],
    episodesCompacted: [],
    indexLinesDropped: [],
    errors: [],
  };
  const log = options.log ?? (() => undefined);

  try {
    if (options.withAgentPass) {
      await agentPass(options, result, /* overBudget */ false, log);
    }

    result.episodesCompacted = compactOldEpisodes(
      options.retentionDays,
      options.baseDir
    ).compactedIds;

    let budget = enforceMemoryIndexBudget(options.baseDir);
    result.indexLinesDropped.push(...budget.droppedEpisodeIds);

    if (budget.overBudget) {
      // Fact lines alone exceed the cap — ask the agent to merge harder.
      await agentPass(options, result, /* overBudget */ true, log);
      budget = enforceMemoryIndexBudget(options.baseDir);
      result.indexLinesDropped.push(...budget.droppedEpisodeIds);
      if (budget.overBudget) {
        result.errors.push("index still over budget after aggressive merge pass");
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}

/** One LLM merge/contradiction pass over the full fact collection. */
async function agentPass(
  options: HygieneOptions,
  result: HygieneResult,
  overBudget: boolean,
  log: (message: string) => void
): Promise<void> {
  const facts = listFactDetails(options.baseDir);
  if (facts.length < 2) {
    return; // Nothing can overlap or contradict.
  }

  let provider: ILLMProvider | undefined;
  try {
    provider = options.getProvider?.();
  } catch (err) {
    result.errors.push(
      `hygiene provider unavailable: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
  if (!provider) {
    return;
  }

  const factBodies = facts
    .map(
      (fact) =>
        `--- fact: ${fact.id} (updated: ${fact.updated || "unknown"}) ---\n` +
        truncateBody(fact.body)
    )
    .join("\n\n");

  const agentResult = await runHygieneAgent(provider, {
    factBodies,
    memoryIndex: readMemoryIndex(options.baseDir),
    overBudgetNote: overBudget ? OVER_BUDGET_NOTE : "",
  });

  if (!agentResult.plan) {
    result.errors.push(agentResult.error ?? "unknown hygiene agent error");
    log(`memory hygiene: agent pass failed — ${agentResult.error}`);
    return;
  }

  applyHygienePlan(agentResult.plan, facts, options.baseDir, result);
}

/**
 * Apply a validated hygiene plan through memoryStore operations only.
 * Ids the plan names that do not exist as facts are silent no-ops; a merge
 * whose absorb list is empty after filtering is skipped entirely (pure
 * rewrites are not allowed — spec §8.3 never-rewrite-wholesale rule).
 */
function applyHygienePlan(
  plan: MemoryHygienePlan,
  facts: FactDetails[],
  baseDir: string | undefined,
  result: HygieneResult
): void {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const today = new Date().toISOString().slice(0, 10);

  for (const merge of plan.merges) {
    if (!byId.has(merge.keepId)) {
      continue;
    }
    const absorbIds = merge.absorbIds.filter(
      (id) => id !== merge.keepId && byId.has(id)
    );
    if (absorbIds.length === 0) {
      continue;
    }

    if (!upsertFactFile(merge.keepId, merge.body, `memory hygiene ${today}`, baseDir)) {
      continue;
    }
    updateMemoryIndex(
      { factEntries: [{ id: merge.keepId, hook: merge.hook }] },
      baseDir
    );
    result.rewrittenFactIds.push(merge.keepId);

    for (const id of absorbIds) {
      if (archiveMemoryEntry(id, baseDir)) {
        result.mergedFactIds.push(id);
        byId.delete(id);
      }
    }
  }

  for (const contradiction of plan.contradictions) {
    const involved = contradiction.ids
      .filter((id, index) => contradiction.ids.indexOf(id) === index)
      .map((id) => byId.get(id))
      .filter((fact): fact is FactDetails => fact !== undefined);
    if (involved.length < 2) {
      continue;
    }

    // Newest wins (spec §8.3): `updated:` is the tiebreaker, then `created:`,
    // then id order for full determinism. The losers get dated archive names.
    const sorted = [...involved].sort(
      (a, b) =>
        b.updated.localeCompare(a.updated) ||
        b.created.localeCompare(a.created) ||
        a.id.localeCompare(b.id)
    );
    for (const loser of sorted.slice(1)) {
      if (archiveMemoryEntry(loser.id, baseDir, { datedFileName: true })) {
        result.contradictionsResolved.push(loser.id);
        byId.delete(loser.id);
      }
    }
  }
}

function truncateBody(body: string): string {
  if (body.length <= MAX_FACT_BODY_CHARS) {
    return body;
  }
  return `${body.slice(0, MAX_FACT_BODY_CHARS)}\n[body truncated]`;
}
