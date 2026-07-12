# Phase M2: Memory Agent + Consolidation

Status: Complete

Implemented on: 2026-07-12

Reference design: [memory-architecture-spec.md](memory-architecture-spec.md) (source of truth).

## Summary

Phase M2 makes memory durable across conversations. A dedicated background
memory agent turns each finished session into a dated episode file, extracts
or updates durable facts, files pending inbox notes, and keeps `MEMORY.md`
accurate — all outside the conversational hot path. The assistant now
remembers "retiens que…" facts on the next launch.

## User-Facing Behavior

- **`/exit` consolidates.** Ending `chat`, `agent-chat`, or `voice-chat`
  prints "Consolidating memory…" and runs the memory agent with a hard 30 s
  timeout (on timeout the session stays pending; the sweep catches it later).
- **Startup catch-up sweep.** Every conversational command fires a silent,
  fire-and-forget consolidation of anything pending (crashed sessions,
  walked-away voice sessions). It never delays the first turn and never
  surfaces a failure. There are no timers.
- `llmtest memory consolidate` — force a run now, with a printed summary.
- `llmtest memory forget <id>` — move a fact/episode to `archive/` and drop
  its index line.
- `MEMORY_AGENT_PROVIDER` / `MEMORY_AGENT_MODEL` (`.env`) point consolidation
  at a cheaper or local model; both default to the main provider/model.

## New Pieces

- `src/memory/consolidation.ts` — orchestrates one run: gather unconsolidated
  inputs (rolling `session.json`, `agent-session.json`, `voice-sessions/*.jsonl`)
  → call the memory agent per session → apply the plan via `memoryStore`
  operations → update the registry. Also owns the `/exit` helper
  (`consolidateOnExit`, 30 s timeout) and the sweep (`startConsolidationSweep`).
- `src/memory/memoryAgent.ts` — the LLM call. Returns a JSON plan
  `{ episode, factUpserts[], archiveIds[] }` validated with ajv; anything
  malformed or oversized is rejected wholesale and nothing touches disk.
  Prompt in `prompts/memory-agent.md` (registered in `templates.ts`, raw-JSON
  output, English memory content).
- `src/memory/memoryStore.ts` extensions — the only write path for curated
  memory: `upsertFactFile` (preserves `created:` and unknown frontmatter keys
  on update), `writeEpisodeFile` (Summary / Decisions / Open threads),
  `archiveMemoryEntry`, `updateMemoryIndex` (line-level, hand-written lines
  untouched), inbox listing/archiving, and the consolidation registry at
  `.state/consolidated.json` (session id → `{ consolidatedAt, messageCount }`).

## Design Decisions / Deviations (spec updated in the same change)

- **The model never writes index lines.** The plan carries a short `hook`
  per episode/fact and the `MEMORY.md` lines are derived in code — the model
  cannot drop unrelated entries, and index updates stay idempotent.
- **Episode id** = `<yyyy-mm-dd>-<first 8 chars of session id>`; re-runs
  overwrite the episode and replace its index line (idempotence). The
  registry's `messageCount` detects resumed-then-exited sessions.
- **Voice double-record dedup.** Voice mode writes both `session.json` and a
  JSONL log; `voice-chat` now gives both the same session id and the gatherer
  prefers the JSONL, so one conversation cannot become two episodes.
- **Inbox notes are archived, not deleted** (`archive/inbox-<name>`), per the
  §6.2 never-hard-delete rule.
- Inbox notes ride along with the first session's agent call; with nothing
  else pending they get a dedicated inbox-only call (`episode: null`).
- Empty sessions (no transcript) are marked consolidated without an LLM call
  so the sweep stops rescanning them; the live voice session is excluded from
  the sweep by id.
- Guardrails enforced in code, not the prompt: kebab-case id validation,
  size caps (≤ 20 fact upserts, ≤ 4000-char bodies), `archiveIds` that don't
  exist are silent no-ops, and a failed/malformed plan leaves every file
  byte-identical and the session unmarked (it retries next trigger).

## Verification

```bash
npm run build
npm test          # 13 suites, 87 tests — all passing
node dist/cli.js memory --help
```

`tests/consolidation.test.ts` covers: full plan application (episode + fact +
index + inbox + registry), idempotent re-runs, grown-session re-consolidation
without duplicate index lines, byte-identical disk state on malformed model
output, archive semantics, inbox-only runs, live-session exclusion, voice
JSONL parsing, plan schema rejection, and `memory forget`.

Left for live testing by Alexy (spec acceptance criteria): say "retiens que X"
in a voice session, `/exit`, relaunch — the fact file exists, `MEMORY.md`
lists it, the assistant uses X; kill a voice session mid-conversation and the
next launch consolidates it in the background.
