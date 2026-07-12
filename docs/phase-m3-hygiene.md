# Phase M3: Memory Hygiene

Status: Complete

Implemented on: 2026-07-12

Reference design: [memory-architecture-spec.md](memory-architecture-spec.md) §8.3 (source of truth).

## Summary

Phase M3 keeps memory quality high as volume grows. Every consolidation run now
ends with a hygiene step: duplicate facts get merged, contradicting facts
resolve to the newest version, episodes past the retention window fold into
quarterly digests, and `MEMORY.md` is held to its 80-line hard budget. Nothing
is ever hard-deleted — every displaced file lands in `archive/`.

## User-Facing Behavior

- **`memory consolidate --deep`** forces the full hygiene pass (LLM
  merge/contradiction analysis over every fact) even when no session is
  pending. The command prints a hygiene summary line (facts merged,
  contradictions resolved, episodes compacted, index lines dropped).
- **Normal consolidations self-clean.** Any run that wrote or updated facts
  (`/exit`, startup sweep, plain `memory consolidate`) triggers the same LLM
  hygiene pass; episode compaction and index budget enforcement run on *every*
  consolidation, LLM or not.
- **`MEMORY_EPISODE_RETENTION_DAYS`** (`.env`, default 90): episodes older than
  this compact into `episodes/compacted-<yyyy-qN>.md` — one bullet per archived
  episode (date, first summary line, original id). Full originals stay readable
  in `archive/`.
- Contradiction losers are archived as `archive/<id>-<yyyy-mm-dd>.md`, so
  successive versions of the same fact stay distinguishable.

## New Pieces

- `src/memory/hygiene.ts` — orchestrates one hygiene pass: agent pass (merges +
  contradiction flags) → episode compaction → index budget → optional
  aggressive-merge pass when the index is still over budget. Never throws;
  failures degrade to `result.hygiene.errors`.
- `src/memory/memoryAgent.ts` — `runHygieneAgent` / `parseHygienePlan` with a
  strict ajv schema: `{ merges: [{keepId, absorbIds[], body, hook}],
  contradictions: [{ids[]}] }`. Malformed plans are rejected wholesale.
- `prompts/memory-hygiene.md` — the hygiene prompt (registered in
  `templates.ts`, raw-JSON output, English content, "when in doubt, do
  nothing").
- `src/memory/memoryStore.ts` extensions — `MEMORY_INDEX_MAX_LINES` (the single
  80-line constant), `listFactDetails` (bodies + `created:`/`updated:` dates),
  `compactOldEpisodes` (quarterly digests, append-only, deduplicated by episode
  id), `enforceMemoryIndexBudget` (drops oldest plain-episode lines; digests
  and fact lines are never dropped by code), dated archive filenames on
  `archiveMemoryEntry`.
- Config: `MEMORY_EPISODE_RETENTION_DAYS` via `loadEpisodeRetentionDays()` in
  `loader.ts`, documented in `.env.example`.
- `ConsolidationResult.hygiene` carries the outcome; `/exit` mentions cleanups
  in its one-line summary.

## Design Decisions / Deviations (spec updated in the same change)

- **The model never picks contradiction winners.** It only flags groups of
  fact ids that cannot all be true; code keeps the newest by `updated:`
  frontmatter (tiebreak `created:`, then id order) and archives the rest.
- **Merges must absorb ≥ 1 existing fact** (schema `minItems: 1` + code
  filter). Pure rewrites are rejected so a runaway model cannot rewrite the
  entire fact collection in one pass.
- **"Compress fact hooks" replaced.** Shorter hooks do not reduce the index
  line count, so the over-budget fallback is instead one extra agent pass with
  an explicit merge-aggressively instruction. Fact lines are never dropped by
  code; a remaining overflow is reported as a hygiene error.
- **Provider creation is lazy.** A consolidation run with nothing pending and a
  clean memory directory performs no LLM call and needs no credentials; the
  hygiene agent pass is skipped when fewer than two facts exist.
- **Digests are append-only.** `compacted-<quarter>.md` gets one bullet per
  episode, deduplicated by `(episode-id)`; existing digest content (including
  hand edits) is never rewritten. Digests are excluded from re-compaction and
  from index-line dropping.
- Guardrails enforced in code as in M2: unknown/hallucinated ids are silent
  no-ops, archive instead of delete everywhere, `upsertFactFile` preserves
  `created:` and unknown frontmatter keys on merge rewrites.

## Verification

```bash
npm run build
npm test          # 14 suites, 102 tests — all passing
node dist/cli.js prompts check
node dist/cli.js memory consolidate --help
```

`tests/hygiene.test.ts` covers the spec acceptance criteria: duplicate merge
(absorbed fact archived, index updated), contradiction resolution (newest
`updated:` wins, loser archived with dated filename), 100 old episodes
compacted into two quarterly digests with the index back under 80 lines and
every displaced file present in `archive/`, idempotent second deep run,
oldest-episode-line dropping for young over-budget indexes, the aggressive
merge pass (with the over-budget note in the second prompt), byte-identical
disk state on malformed hygiene plans, unknown-id no-ops, frontmatter
preservation on merge, and `retentionDays` override.
