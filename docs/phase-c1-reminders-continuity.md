# Phase C1: Reminders & Session Continuity

> **Status: agreed design — source of truth for implementation. Not yet implemented.**
> First slice of [companion-roadmap.md](companion-roadmap.md) (§2.1a reminders +
> §2.2 contextual session opening), designed on 2026-07-12. Per roadmap §5.1, this
> phase also lays the **minimal skeleton for asynchronous tool execution**, so that
> later tool families are born async instead of being retrofitted.
> Coding agents implementing this phase must follow this spec. If an implementation
> constraint forces a deviation, update this document in the same change.

## 1. Goals

1. The user can set, list, and cancel reminders and timers by voice or text:
   "rappelle-moi dans 20 minutes de sortir le plat", "rappelle-moi demain à 9h
   d'appeler X".
2. Reminders fire reliably: spoken aloud during an active voice session, printed in
   an active text session, and delivered at the start of the next session if none
   is active when they come due.
3. Sessions open with continuity: the companion knows what the last conversation
   was about and what was left open, and can say so naturally.
4. A **delivery queue** and a **background-dispatch path** exist in the engine, so
   any future tool can run off the conversational hot path with zero changes to
   this phase's plumbing.

### Non-goals (this phase)

- Recurring reminders (daily/weekly). One-shot only; recurrence arrives with the
  briefing phase (roadmap §5.2), which needs per-topic cadence anyway.
- Web search, weather, local machine control (roadmap §2.1b/c — separate phases).
- Flipping any *existing* tool to background execution. The skeleton is built and
  tested with a fake tool; production tools migrate in later phases.
- Natural-language date parsing in code. The LLM resolves relative times
  ("dans 20 minutes") to absolute timestamps — see §4.3.

## 2. Architecture overview

Three new pieces, one shared principle:

```
                       ┌──────────────────────┐
  reminder ticker ───▶ │                      │ ──▶ active voice session: spoken when idle
                       │   Delivery queue     │ ──▶ active text session: printed between turns
  background task ───▶ │  (.state on disk)    │ ──▶ no session: delivered at next session start
  completions          └──────────────────────┘
```

- **Reminder store + ticker** (`src/engine/reminders.ts`): persistence and due-check.
- **Delivery queue** (`src/engine/deliveryQueue.ts`): the single channel for
  "things to tell the user outside the request/response flow". Reminders are its
  first producer; background task completions are its second. Every future
  background feature (briefing digests, agent results) produces into this queue —
  it is the roadmap-§5.1 backbone.
- **Background dispatch** (`src/engine/backgroundTasks.ts` + agent-loop support):
  tools flagged `background` return an immediate acknowledgment to the model and
  execute detached; their results land in the delivery queue.

**Hot-path rule (same as the memory spec):** none of this may add latency to the
voice turn loop. Startup reads happen once, before the loop. The ticker runs on a
timer, not in the turn path. Delivery into a voice session waits for an idle
moment (§4.2).

## 3. Storage

All state lives under `~/.llmtest/state/` (override: `LLMTEST_STATE_DIR`), beside
the existing session files. Plain JSON, human-readable, safe to delete (deleting
loses pending reminders/tasks but never breaks the app — same degrade-to-empty
convention as `memoryStore`).

```
~/.llmtest/state/
  reminders.json     All reminders, every status. Append/update in place.
  tasks.json         Background task records.
  delivery.json      Pending deliveries not yet shown/spoken to the user.
```

### 3.1 `reminders.json` record

```jsonc
{
  "id": "rem-20260712-a1b2c3",     // rem-<yyyymmdd>-<6 hex chars>
  "text": "sortir le plat",         // user's language, spoken back verbatim
  "dueAt": "2026-07-12T18:20:00+02:00",  // absolute ISO 8601 with offset
  "createdAt": "2026-07-12T18:00:00+02:00",
  "status": "pending",              // pending | delivered | cancelled
  "deliveredAt": null,
  "source": "voice-session <id>"    // same convention as memory `source`
}
```

Delivered and cancelled records are kept (audit trail) and pruned when older than
30 days, code-side, on startup — mirroring the memory system's "never lose bytes
silently, compact on a schedule" stance.

### 3.2 `tasks.json` record

```jsonc
{
  "id": "task-20260712-d4e5f6",
  "toolName": "fake_slow_tool",
  "params": { },
  "status": "running",              // running | done | failed
  "createdAt": "...", "completedAt": null,
  "result": null,                   // tool result (stringified) once done
  "sessionId": "..."                // session that dispatched it
}
```

Tasks marked `running` at startup are stale (process died): they are marked
`failed` with reason `interrupted` during the startup sweep, and a failure notice
is queued for delivery. v1 does not resume interrupted tasks.

### 3.3 `delivery.json` record

```jsonc
{
  "id": "dlv-...",
  "kind": "reminder" | "task_result" | "task_failure",
  "refId": "rem-... | task-...",
  "text": "Tu m'avais demandé de te rappeler de sortir le plat.",
  "queuedAt": "...",
  "deliveredAt": null
}
```

The `text` is composed at queue time by code from templates (no LLM call), in
French for reminder deliveries since the reminder text is the user's own words.

## 4. Behavior

### 4.1 Setting reminders — tools

Three new tools implementing `IToolProvider`, registered in `TOOL_REGISTRY`
(available in `agent-chat` and `voice-chat --agent`, like the memory tools;
plain `chat`/`voice-chat` have no tool path — unchanged):

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `reminder_set` | `text: string`, `due_at: string` (ISO 8601) | Validate `due_at` parses and is in the future; persist; return confirmation with the id and a human-readable due time. |
| `reminder_list` | *(none)* | Return pending reminders (id, text, due time), soonest first. |
| `reminder_cancel` | `id: string` | Mark cancelled; error string if unknown/not pending. |

Like the memory tools, these ignore `sandboxDir` and operate only on the state
directory. Invalid input returns an error *string* (the agent-loop convention),
never a throw that kills the loop.

### 4.2 Firing reminders — ticker and delivery

- An in-process ticker (default every 5 s, `LLMTEST_REMINDER_TICK_MS`) runs while
  any conversational command is active. On each tick: any `pending` reminder with
  `dueAt <= now` is marked delivered-in-progress, composed into a delivery record,
  and queued.
- **Voice session:** the queue is drained only when the loop is idle — not
  capturing user speech and not already speaking. Delivery speaks the text through
  the existing streaming TTS path; barge-in applies to reminder speech exactly as
  to normal responses. If the user is mid-conversation, the reminder waits for the
  turn boundary (a reminder may fire seconds late; it must never talk over the
  user or collide with a response).
- **Text session (`chat`/`agent-chat`):** drained between turns — printed before
  the next prompt is shown.
- **No session:** the delivery stays queued. At the next session start, all
  pending deliveries are folded into the opening context (§4.4) and marked
  delivered.
- After successful delivery, the reminder's status becomes `delivered`. Speech
  interrupted by barge-in still counts as delivered (v1 keeps this simple).

### 4.3 Time resolution — model-side, verified code-side

The code never parses natural language dates. Instead:

- The agent turn prompt (templates in `src/prompts/templates.ts`) gains a line
  with the **current date, time, and UTC offset**, plus tool guidance: *"resolve
  relative times against the current time and pass `due_at` as absolute ISO 8601
  with offset"*.
- `reminder_set` validates the result: parseable, in the future, less than one
  year out. On failure it returns an error string telling the model what to fix —
  the loop's normal self-correction path.

### 4.4 Contextual session opening

At startup of `chat`, `agent-chat`, and `voice-chat` (all modes), **once, before
the turn loop**:

1. Read the most recent episode (by frontmatter `date`, tie-broken by file mtime)
   via `memoryStore` — reuse `listMemoryEntries`/`readMemoryEntry`; no new read
   primitives.
2. Drain pending deliveries (§4.2) and collect due-today reminders.
3. Build an **opening context block** appended to the existing memory preamble
   (`buildMemoryPreambleMessages` gains an options field; same transient
   `user`/`model` preamble mechanism — never persisted to the session file):
   - last episode's summary and open threads;
   - missed deliveries ("pendant ton absence…");
   - reminders due today.
4. The block carries the instruction: *"If this is the session's first exchange
   and there are open threads or missed deliveries, briefly acknowledge them
   naturally in your first reply. Do not recite the list; weave in at most the
   one or two most relevant items."*

No extra LLM call at startup — zero added latency beyond one episode file read.
When there is no episode and nothing queued, the block is empty and costs zero
tokens (same convention as the memory block).

### 4.5 Background dispatch skeleton

The roadmap-§5.1 foundation, kept deliberately minimal:

- `IToolProvider` gains an optional `background?: boolean` (absent = synchronous;
  non-breaking for all existing tools).
- In `runAgentLoop`, when a called tool has `background: true`: create a task
  record, start `execute()` detached (`.then`/`.catch` writing status + queueing a
  `task_result`/`task_failure` delivery), and immediately push the tool result
  `[dispatched in background: task <id>] — tell the user you'll report back` into
  the message history. The loop continues without awaiting.
- Task completions surface exclusively through the delivery queue — same idle
  rules as reminders. There is no polling tool in v1 (a `task_status` tool can
  come with the first real background tool family).
- **No production tool sets the flag in this phase.** The path is exercised by a
  fake slow tool in tests only.

### 4.6 CLI

A new `reminders` command, following the `memory` command's pattern:

- `llmtest reminders list` — pending first (soonest-due first), then recent
  delivered/cancelled.
- `llmtest reminders cancel <id>`.

Inside conversational modes, `/reminders` prints the pending list (same
mechanism as the existing `/memory`).

## 5. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLMTEST_STATE_DIR` | `~/.llmtest/state` | Location of reminders/tasks/delivery JSON. |
| `LLMTEST_REMINDER_TICK_MS` | `5000` | Ticker interval. |

Both read in `src/config/loader.ts` following the existing `loadEpisodeRetentionDays`
pattern (env → default, validated).

## 6. Testing

Project convention: Jest, all LLM and TTS/STT calls mocked, file operations
against temp directories, timers via fake clocks (`jest.useFakeTimers`).

- **Reminder store:** set/list/cancel round-trips; invalid `due_at` (past,
  unparseable, > 1 year) returns error strings; pruning of >30-day-old
  delivered/cancelled records; corrupted/missing JSON degrades to empty, never
  throws.
- **Ticker + delivery:** due reminder → delivery queued exactly once (no
  double-fire across ticks); idle-gating honored (nothing delivered while a fake
  "speaking"/"capturing" flag is up); no-session deliveries persist and surface
  at next startup.
- **Opening context:** with a seeded episode + queued delivery, the preamble
  contains summary, open threads, and the missed delivery; with empty memory and
  empty queue, the block is empty; the preamble is never written to the session
  file.
- **Background dispatch:** fake slow tool with `background: true` → loop receives
  the immediate dispatch message and continues; completion writes `done` +
  queues a `task_result`; a rejecting tool queues `task_failure`; stale `running`
  task at startup → marked `failed (interrupted)` + failure delivery queued.
- **Agent-loop regression:** all existing tools still execute synchronously and
  existing agent tests pass unchanged.

## 7. Acceptance criteria

1. In `voice-chat --agent`: "rappelle-moi dans 2 minutes de X" → confirmation
   spoken; ~2 minutes later, with the loop idle, the reminder is spoken; barge-in
   during the reminder cuts it.
2. Set a reminder, quit, wait past its due time, relaunch: the opening reply
   mentions the missed reminder.
3. After a session that left open threads, the next session's first reply
   acknowledges them naturally (verified by inspecting the injected preamble in
   tests; conversational quality hand-checked by Alexy).
4. `llmtest reminders list`/`cancel` and `/reminders` behave as specified.
5. A test-only background tool round-trips through dispatch → delivery queue
   without blocking the agent loop.
6. Voice turn latency is unchanged (no new work in the turn path; verified by the
   existing timing metrics).

## 8. Open questions (non-blocking)

- Should reminder delivery in voice mode use a dedicated audio cue (short chime
  before speaking) so it is not mistaken for a conversational reply? Decide
  during implementation; a cue file fits the existing playback path.
- Exact idle-detection hook in the voice loop (which existing state flags to
  read) is an implementation detail — whatever is chosen, the test suite's
  idle-gating contract (§6) is the source of truth.
