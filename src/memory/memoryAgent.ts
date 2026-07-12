/**
 * Memory Agent — the LLM calls at the heart of consolidation (spec §6, §8.2)
 * and hygiene (spec §8.3).
 *
 * Consolidation call: one finished session transcript, the current memory
 * state, and any pending inbox notes → a JSON plan. Hygiene call: full fact
 * bodies → a merge/contradiction plan. Both outputs are validated against
 * strict schemas — malformed or oversized plans are rejected wholesale and
 * nothing touches disk (guardrails live in consolidation.ts / hygiene.ts,
 * not in the model).
 *
 * Prompts live in prompts/memory-agent.md and prompts/memory-hygiene.md
 * (registered in templates.ts).
 */

import { ILLMProvider } from "../providers/ILLMProvider";
import { renderPrompt } from "../prompts/promptLoader";
import { validateJsonSchema } from "../validation/jsonSchemaValidator";

export interface MemoryAgentInput {
  /** yyyy-mm-dd of the session being consolidated. */
  date: string;
  /** Conversation channel, e.g. "text chat", "agent chat", "voice". */
  channel: string;
  /** Formatted transcript; empty string for an inbox-only run. */
  transcript: string;
  /** Current MEMORY.md content. */
  memoryIndex: string;
  /** One line per existing fact: "- <id>: <first body line>". */
  factSummaries: string;
  /** Pending inbox notes, formatted; "(none)" when empty. */
  inboxNotes: string;
}

export interface MemoryAgentEpisode {
  summary: string;
  decisions: string[];
  openThreads: string[];
  /** Short index-line hook for MEMORY.md. */
  hook: string;
}

export interface MemoryAgentFactUpsert {
  id: string;
  body: string;
  /** Short index-line hook for MEMORY.md. */
  hook: string;
}

export interface MemoryAgentPlan {
  /** null when the transcript holds nothing worth an episode (inbox-only runs). */
  episode: MemoryAgentEpisode | null;
  factUpserts: MemoryAgentFactUpsert[];
  /** Existing fact/episode ids to move to archive/ ("oublie que…" requests). */
  archiveIds: string[];
}

/** New fact ids must be kebab-case slugs; keep in sync with the prompt. */
const PLAN_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

/**
 * Hard size limits (spec §8.2: "malformed/oversized plans rejected
 * wholesale"). Generous for a single conversation, small enough that a
 * runaway model cannot flood the memory directory.
 */
export const MEMORY_AGENT_PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["episode", "factUpserts", "archiveIds"],
  properties: {
    episode: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          required: ["summary", "decisions", "openThreads", "hook"],
          properties: {
            summary: { type: "string", minLength: 1, maxLength: 4000 },
            decisions: {
              type: "array",
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
            openThreads: {
              type: "array",
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
            hook: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      ],
    },
    factUpserts: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["id", "body", "hook"],
        properties: {
          id: { type: "string", pattern: PLAN_ID_PATTERN },
          body: { type: "string", minLength: 1, maxLength: 4000 },
          hook: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
    archiveIds: {
      type: "array",
      maxItems: 40,
      items: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
};

export interface MemoryAgentResult {
  plan: MemoryAgentPlan | null;
  /** Present when plan is null: why the run must be abandoned. */
  error?: string;
}

/**
 * Run one memory-agent call. Returns a validated plan, or a null plan with an
 * error — the caller must change nothing on disk in that case.
 */
export async function runMemoryAgent(
  provider: ILLMProvider,
  input: MemoryAgentInput,
  options: { model?: string; promptsDir?: string } = {}
): Promise<MemoryAgentResult> {
  const prompt = renderPrompt(
    "memory-agent",
    {
      date: input.date,
      channel: input.channel,
      transcript: input.transcript || "(no transcript — inbox notes only)",
      memoryIndex: input.memoryIndex.trim() || "(empty index)",
      factSummaries: input.factSummaries.trim() || "(no facts yet)",
      inboxNotes: input.inboxNotes.trim() || "(none)",
    },
    { promptsDir: options.promptsDir }
  );

  let rawText: string;
  try {
    const result = await provider.prompt({
      prompt,
      model: options.model,
      temperature: 0,
      responseFormat: "json",
    });
    rawText = result.text;
  } catch (err) {
    return {
      plan: null,
      error: `memory agent call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return parseMemoryAgentPlan(rawText);
}

/**
 * Parse and validate the model's raw output. Never trusts the model: code
 * fences are stripped, the JSON is schema-validated with ajv, and anything
 * that does not conform rejects the whole plan.
 */
export function parseMemoryAgentPlan(rawText: string): MemoryAgentResult {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { plan: null, error: "memory agent returned invalid JSON" };
  }

  const validation = validateJsonSchema(parsed, MEMORY_AGENT_PLAN_SCHEMA);
  if (!validation.valid) {
    return {
      plan: null,
      error: `memory agent plan failed validation: ${validation.errors.join("; ")}`,
    };
  }

  return { plan: parsed as MemoryAgentPlan };
}

// ── Phase M3: hygiene call (spec §8.3) ────────────────────────────────

export interface HygieneAgentInput {
  /** Full fact bodies, one block per fact with its updated date. */
  factBodies: string;
  /** Current MEMORY.md content. */
  memoryIndex: string;
  /** Extra instruction when the index is over budget; "" otherwise. */
  overBudgetNote: string;
}

export interface HygieneMerge {
  /** Surviving fact id — must already exist. */
  keepId: string;
  /** Redundant fact ids absorbed into keepId, then archived. */
  absorbIds: string[];
  /** Complete merged body replacing keepId's body. */
  body: string;
  /** Fresh short index hook for keepId. */
  hook: string;
}

export interface HygieneContradiction {
  /** Facts that cannot all be true. Code keeps the newest, archives the rest. */
  ids: string[];
}

export interface MemoryHygienePlan {
  merges: HygieneMerge[];
  contradictions: HygieneContradiction[];
}

/**
 * Hygiene plan limits. A merge must absorb at least one fact — pure body
 * rewrites are not allowed, so a runaway model cannot rewrite the whole fact
 * collection in one pass.
 */
export const MEMORY_HYGIENE_PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["merges", "contradictions"],
  properties: {
    merges: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["keepId", "absorbIds", "body", "hook"],
        properties: {
          keepId: { type: "string", pattern: PLAN_ID_PATTERN },
          absorbIds: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
          body: { type: "string", minLength: 1, maxLength: 4000 },
          hook: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
    contradictions: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["ids"],
        properties: {
          ids: {
            type: "array",
            minItems: 2,
            maxItems: 5,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
      },
    },
  },
};

export interface HygieneAgentResult {
  plan: MemoryHygienePlan | null;
  /** Present when plan is null: why the hygiene pass must be skipped. */
  error?: string;
}

/**
 * Run one hygiene-agent call. Returns a validated merge/contradiction plan,
 * or a null plan with an error — the caller must change nothing in that case.
 */
export async function runHygieneAgent(
  provider: ILLMProvider,
  input: HygieneAgentInput,
  options: { model?: string; promptsDir?: string } = {}
): Promise<HygieneAgentResult> {
  const prompt = renderPrompt(
    "memory-hygiene",
    {
      factBodies: input.factBodies.trim() || "(no facts)",
      memoryIndex: input.memoryIndex.trim() || "(empty index)",
      overBudgetNote: input.overBudgetNote,
    },
    { promptsDir: options.promptsDir }
  );

  let rawText: string;
  try {
    const result = await provider.prompt({
      prompt,
      model: options.model,
      temperature: 0,
      responseFormat: "json",
    });
    rawText = result.text;
  } catch (err) {
    return {
      plan: null,
      error: `hygiene agent call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return parseHygienePlan(rawText);
}

/** Parse and validate the hygiene model output. Same trust level: none. */
export function parseHygienePlan(rawText: string): HygieneAgentResult {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { plan: null, error: "hygiene agent returned invalid JSON" };
  }

  const validation = validateJsonSchema(parsed, MEMORY_HYGIENE_PLAN_SCHEMA);
  if (!validation.valid) {
    return {
      plan: null,
      error: `hygiene plan failed validation: ${validation.errors.join("; ")}`,
    };
  }

  return { plan: parsed as MemoryHygienePlan };
}
