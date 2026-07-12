# Memory Architecture Specification

> **Status: agreed design — source of truth for implementation.**
> Decisions in this document were converged on between Alexy and Claude on 2026-07-12.
> Coding agents implementing memory features must follow this spec. If an implementation
> constraint forces a deviation, update this document in the same change.

## 1. Goals

Give the companion a durable, layered memory so that:

1. Context persists within a conversation (already works today).
2. Important facts and events survive across conversations.
3. Long-term knowledge about the user accumulates, stays clean, and does not grow unbounded.
4. The user can **read and edit every memory by hand** — memory is plain Markdown on disk,
   never an opaque store.
5. The real-time voice loop is **never** slowed down by memory work. All memory writing and
   maintenance happens outside the conversational hot path.

### Non-goals (for now)

- Vector databases / embeddings. Plain-text index + file reads are sufficient at
  single-user scale. Semantic search may be added later if the index grows past ~100 entries.
- Multi-user support. There is exactly one user.
- Memory for test/benchmark commands (`run`, `compare`, `rag`, …). Memory applies to the
  conversational surfaces only.

## 2. The three memory tiers

| Tier | Name | Contents | Lifetime | Exists today? |
| --- | --- | --- | --- | --- |
| 1 | **Working memory** | Message history of the current conversation | One session | Yes — `~/.llmtest/session.json`, `agent-session.json`, voice JSONL transcripts |
| 2 | **Episodic memory** | One dated summary per past conversation: what was discussed, decided, left open | Weeks–months, then compacted | No |
| 3 | **Semantic memory** | Durable facts detached from their source conversation: user preferences, ongoing projects, life context, confirmed decisions | Indefinite, curated | No |

Tier 3 is not "older tier 2". It is a **consolidation**: a fact is promoted to tier 3 when
it is structural (a preference, a project, a standing constraint) or explicitly confirmed —
not merely because it aged.

## 3. Storage layout

All memory lives under `~/.llmtest/memory/`:

```
~/.llmtest/memory/
  MEMORY.md          Index. One line per memory. Loaded into the system prompt
                     of every conversational session. Hard budget: ≤ 80 lines.
  facts/             Tier 3. One Markdown file per fact/topic.
  episodes/          Tier 2. One Markdown file per consolidated past conversation.
  inbox/             Drop-box for raw, unprocessed notes (see §5.2). Plain .md files.
  archive/           Soft-deleted / compacted material. Never loaded into prompts.
```

### 3.1 File format

Every file in `facts/` and `episodes/` uses YAML frontmatter + Markdown body:

```markdown
---
id: user-prefers-short-answers        # kebab-case slug, matches filename
type: fact                            # fact | episode
created: 2026-07-12
updated: 2026-07-12
source: voice-session 2026-07-12      # where this came from
---

Alexy prefers short, direct spoken answers; long explanations only when he asks.
```

Episode files additionally carry `session_id` and `date` in frontmatter, and their body
follows a fixed shape: **Summary / Decisions / Open threads**.

### 3.2 Language

Memory files are written in **English** (more robust across models). The agent always
converses with the user in the user's language (French) regardless of memory language.
User-injected content (e.g. French documents) may remain in its original language.

### 3.3 `MEMORY.md` index format

One line per entry, no frontmatter, grouped under `## Facts` and `## Recent episodes`:

```markdown
- [user-prefers-short-answers](facts/user-prefers-short-answers.md) — short spoken answers by default
```

The index is the only memory content injected unconditionally. Everything else is
retrieved on demand.

## 4. Read path

1. At the start of every `chat`, `agent-chat`, and `voice-chat` session, the full text of
   `MEMORY.md` is injected into the system prompt.
2. Two new built-in tools are exposed to the agent:
   - `memory_read(id)` — return the full body of a fact or episode file.
   - `memory_note(text)` — append a raw note to `inbox/` (see §5.2).
3. If the agent needs detail behind an index line, it calls `memory_read`. No automatic
   retrieval, no embeddings.

Memory is **shared across all modes** (text chat, agent chat, voice). It is one companion
that knows one user; the channel is irrelevant.

## 5. Write path

**Invariant: the conversational agent never writes to `facts/`, `episodes/`, or
`MEMORY.md` directly.** All curated writes go through the memory agent (§6). The only
write the conversational agent may perform is appending to `inbox/`.

### 5.1 Consolidation triggers

1. **Explicit session end** — `/exit` in any conversational mode queues the just-ended
   session for consolidation.
2. **Startup catch-up sweep** — every session transcript carries a `consolidated` marker
   (a sidecar flag or registry entry). On application startup, any unconsolidated
   transcripts are queued and processed in the background while the new session starts.
   This covers crashes, network cuts, and voice sessions the user simply walked away from.
   There are **no timers**.

### 5.2 Explicit remember command ("retiens que…")

Two-phase, so the voice loop never blocks:

1. **Fast phase (conversational agent, real time):** when the user says "retiens que…" /
   "n'oublie pas que…" / "remember that…", the agent calls `memory_note(text)` which
   appends a raw timestamped note to `inbox/`, and immediately acknowledges verbally.
   In **plain (non-agent) voice mode** there are no tools, so the fast phase runs on
   transcript pattern matching instead: a final user transcript that matches a
   remember-intent pattern (`detectRememberIntent`) is copied raw into `inbox/`.
   In **agent modes** the same detection runs as a safety net: if a matching turn
   finishes without a `memory_note` call, the raw transcript is written to `inbox/`
   anyway — a false "c'est noté" must never lose the user's fact.
   Over-capture is acceptable — the memory agent discards false positives during
   consolidation; missing a genuine request is not.
2. **Slow phase (memory agent, background):** at the next consolidation run, inbox notes
   are formatted, deduplicated against existing facts, filed into `facts/`, indexed in
   `MEMORY.md`, and removed from `inbox/`.

## 6. The memory agent

A dedicated background agent, invoked only at consolidation triggers — never resident,
never in the voice loop. It is the pilot case for the future orchestrator architecture:
the same "main agent delegates to background agent" plumbing will later serve web
research, document writing, etc.

### 6.1 Responsibilities

Given a finished session transcript and the current memory state, the memory agent:

1. Writes the **episode summary** to `episodes/` (Summary / Decisions / Open threads).
2. **Extracts durable facts** and creates or updates files in `facts/`. Updating an
   existing fact is preferred over creating a near-duplicate.
3. Processes all pending `inbox/` notes.
4. **Maintains hygiene** ("agentic consolidation"):
   - merges duplicate or overlapping facts;
   - rewrites facts contradicted by newer information (newest wins; the old version
     moves to `archive/`);
   - compacts old episodes: episodes older than ~3 months are merged into a single
     `episodes/compacted-<period>.md` digest and the originals move to `archive/`;
   - keeps `MEMORY.md` accurate, deduplicated, and within its 80-line budget. When over
     budget, the least-load-bearing entries are the ones compacted or archived first.
5. Marks the session transcript as consolidated.

### 6.2 Guardrails

- The memory agent **never hard-deletes**: removal means moving to `archive/`.
- It must tolerate hand-edited files (the user is allowed to edit anything in
  `memory/`): unknown formatting is preserved, never rewritten wholesale.
- Runs are idempotent: re-consolidating an already-consolidated transcript must not
  create duplicates.
- It runs with file access restricted to `~/.llmtest/memory/` and read-only access to
  session transcripts.

### 6.3 Model choice

The memory agent is latency-insensitive, so it can use a different (cheaper or local)
model than the conversational agent. Model/provider for the memory agent is configured
independently via `MEMORY_AGENT_PROVIDER` / `MEMORY_AGENT_MODEL`, defaulting to the main
provider/model.

## 7. User-facing surface

### CLI

```
llmtest memory list              # show the index
llmtest memory show <id>         # print one fact/episode
llmtest memory edit <id>         # open in $EDITOR / notepad
llmtest memory forget <id>       # move to archive/
llmtest memory consolidate       # force a consolidation run now
```

(Plus: the whole directory is plain Markdown — editing files directly is always
supported and must never break the system. §6.2.)

### Voice / chat commands

| Utterance / command | Effect |
| --- | --- |
| "retiens que…", "remember that…" | `memory_note` fast path (§5.2) |
| "qu'est-ce que tu sais sur…" | agent answers from index + `memory_read` |
| "oublie que…" | agent notes a forget-request in `inbox/`; memory agent archives the fact at next consolidation |
| `/memory` (terminal, during chat) | print the current index |

## 8. Implementation phases

Follow the existing `docs/phase-N-*.md` convention (write a `phase-mN-*.md` doc when the
phase lands); each phase lands independently.

### 8.0 Shared context for every phase

Read this before implementing any phase — it is the codebase knowledge M1 had to
discover the hard way.

- **Key files.** `src/memory/memoryStore.ts` (all file-level memory operations —
  extend it, don't bypass it), `src/session/session.ts` (session persistence:
  `~/.llmtest/session.json` for text chat, `agent-session.json` for agent chat, one
  JSONL per voice session under `~/.llmtest/voice-sessions/`),
  `src/engine/agentLoop.ts` (`runAgentLoop`, accepts `priorMessages`),
  `src/commands/{chat,agentChat,voiceChat,memory}.ts`, `src/providers/factory.ts`
  (`createProvider`), `src/prompts/templates.ts` (runtime prompt registration).
- **No system role.** `Message.role` is `"user" | "model"` only. Context is injected
  either as a transient user/model preamble pair (chat modes) or embedded in the turn
  prompt (see M1 for both patterns). Never persist injected context in session files.
- **Memory must never crash a conversation.** Every memory function degrades to empty
  results / no-ops on errors. Keep that property.
- **Runtime prompts.** Model-facing instructions that the user may want to tune belong
  in `prompts/*.md`, registered in `src/prompts/templates.ts` with a fallback string
  and validated by `prompts check`. The memory agent's prompt must follow this system.
- **Config.** New settings go through `src/config/loader.ts` and get documented in
  `.env.example`. `LLMTEST_MEMORY_DIR` already overrides the memory root.
- **Testing.** Jest, all LLM/audio boundaries mocked, file operations against
  `fs.mkdtempSync` temp dirs (see `tests/memoryStore.test.ts` for the pattern; use the
  `LLMTEST_MEMORY_DIR` env var save/restore pattern from `tests/memoryTools.test.ts`
  when code reads the default paths). JSON from an LLM is validated with ajv via
  `src/validation/jsonSchemaValidator.ts` — never trust raw model output.
- **Language.** Memory files and prompts in English; the assistant converses in French.

### 8.1 Phase M1 — storage + read path (landed 2026-07-12)

Done; see [phase-m1-memory-foundation.md](phase-m1-memory-foundation.md) for what
exists and the post-M1 fixes (tier-1 history in voice agent turns, remember-intent
safety net, always-on tool instructions).

### 8.2 Phase M2 — memory agent + consolidation (landed 2026-07-12)

Done; see [phase-m2-memory-agent.md](phase-m2-memory-agent.md).

**Goal:** finished conversations become episode files and updated facts; inbox notes
get filed; the assistant finally remembers across sessions.

**New pieces.**

- `src/memory/consolidation.ts` — orchestrates one consolidation run:
  gather unconsolidated inputs → call the memory agent → apply its plan via
  `memoryStore` operations → update the registry.
- `src/memory/memoryAgent.ts` — the LLM call. Input: session transcript(s), current
  `MEMORY.md`, existing fact ids + descriptions, pending inbox notes. Output: a JSON
  plan `{ episode, factUpserts[], archiveIds[] }` validated against a schema (ajv).
  The model never emits raw index lines: the episode and each fact upsert carry a
  short `hook` string, and the `MEMORY.md` lines are derived from those in code —
  safer (the model cannot drop unrelated entries) and what makes index updates
  idempotent. Prompt lives in `prompts/memory-agent.md` (register in
  `templates.ts`; force raw-JSON output like `judge-strict.md` does).
- **Registry** at `~/.llmtest/memory/.state/consolidated.json`: maps session id →
  `{ consolidatedAt, messageCount }`. This is the "consolidated marker" of §5.1.
- Config: `MEMORY_AGENT_PROVIDER` / `MEMORY_AGENT_MODEL` (default: main
  provider/model) resolved in `loader.ts`, used via `createProvider`.
- CLI: `memory consolidate` (force a run now), `memory forget <id>` (move a fact to
  `archive/` and drop its index line).

**Trigger wiring.**

- `/exit`: run consolidation *before* `process.exit`, with a short console notice
  ("Consolidating memory…") and a hard timeout (~30 s; on timeout, leave the session
  unconsolidated — the sweep will catch it). Hook points: after `waitUntilExit()` in
  `chat.ts` / `agentChat.ts`, and after the main loop ends in `voiceChatCommand`.
- **Startup catch-up sweep**: at the start of the three conversational commands,
  fire-and-forget (never `await` before the conversation starts, never let a failure
  surface): scan the registry vs. `voice-sessions/*.jsonl` + current
  `session.json` / `agent-session.json`, consolidate anything pending.

**Design decisions already made.**

- Episode id = `<yyyy-mm-dd>-<first 8 chars of session id>`. Re-consolidating the same
  session **overwrites** its episode file and re-derives its index line — that is what
  makes runs idempotent, including text sessions that are resumed and exited again
  (the registry's `messageCount` tells you whether anything new happened).
- Text and agent chat use a single rolling session file, so the transcript to
  consolidate is simply the file's current `messages`. Voice sessions are the JSONL
  logs (use `final_transcript` and `assistant_final` events; `memory_note` events tell
  you what was already captured). Voice mode also writes the conversation to the
  rolling `session.json`; to prevent the same conversation from becoming two episodes,
  `voice-chat` gives both records the same session id and the gatherer dedupes by id,
  preferring the JSONL.
- "Removed from inbox" (§5.2) follows the §6.2 rule like everything else: processed
  notes move to `archive/inbox-<name>`, they are never hard-deleted.
- Fact upserts prefer updating an existing fact file over creating a near-duplicate;
  the plan schema forces the model to choose an existing id or a new one explicitly.
- "Oublie que…" requests found in transcripts/inbox become `archiveIds` in the plan.
- Guardrails (§6.2) are enforced in `consolidation.ts`, not trusted to the model:
  writes only under the memory root, archive instead of delete, unknown files left
  untouched, malformed/oversized plans rejected wholesale (fail the run, change
  nothing on disk).

**Acceptance criteria.**

- Say "retiens que X" in a voice session, `/exit`, relaunch: the fact file exists,
  `MEMORY.md` lists it, the assistant uses X in the new session; inbox is empty.
- Kill a voice session mid-conversation; the next launch consolidates it in the
  background (registry updated, episode written) without delaying the first turn.
- Running `memory consolidate` twice in a row changes nothing the second time.
- A malformed LLM response leaves every file byte-identical.

### 8.3 Phase M3 — hygiene (landed 2026-07-12)

Done; see [phase-m3-hygiene.md](phase-m3-hygiene.md).

**Goal:** memory quality stays high as volume grows; nothing grows unbounded.

Runs as an extra step of every consolidation (plus `memory consolidate --deep` to
force a full pass). All M2 guardrails apply; everything displaced goes to `archive/`.

**Scope.**

- **Duplicate merge:** the memory agent receives full fact bodies (not just ids) for
  candidate clusters and returns merge plans (`keepId`, `absorbIds[]`, merged body).
  A merge must absorb at least one existing fact — pure single-fact rewrites are
  rejected, so a runaway model cannot rewrite the whole collection in one pass.
- **Contradiction resolution:** newest wins; the losing version moves to `archive/`
  with a dated filename. The fact file's `updated:` frontmatter is the tiebreaker
  (then `created:`, then id order). The model only flags contradiction groups; the
  winner is picked in code.
- **Episode compaction:** episodes older than `MEMORY_EPISODE_RETENTION_DAYS`
  (default 90, new config) merge into `episodes/compacted-<yyyy-qN>.md` digests.
- **Index budget:** hard cap of 80 lines in `MEMORY.md` enforced in code after the
  agent's pass — if still over, the oldest plain-episode lines drop first (compacted
  digests are kept). The cap lives in one constant in `memoryStore.ts`.
  *(Deviation from the original design: "ask the agent to compress fact hooks" was
  dropped — shorter hooks do not reduce the line count. Instead, when fact lines
  alone still exceed the cap, one extra agent pass runs with an explicit
  merge-aggressively instruction; fact lines are never dropped by code.)*
- The LLM merge/contradiction pass runs on every consolidation that changed facts
  and on `--deep`; the code-side steps (compaction, budget) run on every
  consolidation including the startup sweep.
- Never rewrite a hand-edited file wholesale: hygiene edits preserve any frontmatter
  keys and body sections the schema does not know about.

**Acceptance criteria:** seed fixtures with duplicates, a contradiction, 100 fake old
episodes and an over-budget index; after one deep run: merged facts reference the
surviving id, the contradiction resolves to the newer value with the loser archived,
old episodes are compacted into digests, the index is ≤ 80 lines, and nothing was
hard-deleted (archive contains every displaced byte).

### 8.4 Phase M4 — retrieval upgrades (optional, gated)

**Do not build until the trigger fires:** `MEMORY.md` regularly pressing its 80-line
budget despite M3, or facts routinely too large to inject usefully.

Direction when it does: a `memory_search(query)` tool over full fact/episode bodies
(index stays prompt-injected as today). Prefer local embeddings —
`onnxruntime-node` is already a dependency (a small sentence-embedding ONNX model
follows the same setup pattern as the TTS/STT sidecars in `tools/`), or Ollama's
embedding endpoint when the user runs Ollama anyway. Store vectors in a plain JSON
sidecar under `.state/` keyed by file path + content hash (re-embed on hash change);
brute-force cosine over a few hundred entries is plenty. The Markdown files remain
the single source of truth — the vector store is a disposable cache, safe to delete.

Testing follows the project convention: Jest with all LLM calls mocked. Consolidation
logic must be testable with a fake transcript + fake LLM responses; file operations are
tested against a temp directory.

## 9. Open questions (non-blocking)

- ~~Exact wake-phrase detection for "retiens que" in voice mode~~ — resolved in M1:
  prompt-level instruction (memory_note tool) in agent modes, transcript pattern
  matching in plain voice mode (§5.2).
- ~~Whether episode compaction period (3 months) should be configurable~~ — resolved
  in §8.3: yes, `MEMORY_EPISODE_RETENTION_DAYS=90` (new config in Phase M3).
