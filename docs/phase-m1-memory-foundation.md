# Phase M1: Memory Foundation — Storage + Read Path

Status: Complete

Implemented on: 2026-07-12

Reference design: [memory-architecture-spec.md](memory-architecture-spec.md) (source of truth).

## Summary

Phase M1 lands the first slice of the layered memory system: the on-disk
Markdown layout under `~/.llmtest/memory/`, the read path that injects the
memory index into every conversational mode, the `memory_read` / `memory_note`
agent tools, and the `memory` CLI for inspecting and editing memory by hand.

There is no consolidation yet (Phase M2): inbox notes accumulate untouched and
`facts/` / `episodes/` are only populated by hand or by future phases.

## User-Facing Behavior

- `llmtest memory list` — show the memory directory, entry counts, pending
  inbox notes, and the full index.
- `llmtest memory show <id>` — print one fact or episode.
- `llmtest memory edit <id>` — open an entry in `$EDITOR` (notepad fallback).
- `/memory` — print the index from inside `chat`, `agent-chat`, and
  `voice-chat`.
- In `agent-chat` and `voice-chat --agent`, the model can call `memory_read`
  to pull the detail behind an index entry, and `memory_note` when the user
  says "retiens que…" / "remember that…" (raw note into `inbox/`).
- Every file under `~/.llmtest/memory/` is plain Markdown the user can edit
  freely; hand edits never break the system.
- `LLMTEST_MEMORY_DIR` overrides the memory directory location.

## Implementation Notes

- New module `src/memory/memoryStore.ts`: layout creation (idempotent),
  index reading, entry listing/reading (path-traversal-safe ids), inbox note
  appending, and prompt-block builders. All functions accept an optional
  `baseDir` for tests and degrade to empty results instead of throwing.
- Memory injection per mode, following each mode's existing prompt pattern:
  - `chat` and plain `voice-chat`: a transient `user`/`model` preamble pair is
    prepended to the messages sent to the provider (there is no system role in
    the `Message` type). It is rebuilt from disk each turn and never persisted
    in the session file.
  - `agent-chat` and `voice-chat --agent`: agent turns are standalone, so the
    memory block (with tool instructions) is embedded in the turn prompt.
  - When the index has no entries the block is empty and costs zero tokens.
- New tools `src/providers/tools/memoryRead.ts` and `memoryNote.ts`,
  registered in `TOOL_REGISTRY`, so they are part of the default "all tools"
  set in both agent modes. They ignore the sandbox and operate only inside the
  memory directory (ids cannot traverse out of it).
- `ChatInterface`'s `onSlashCommand` contract extended: a returned string is
  displayed as the command's output (used by `/memory`).
- "Retiens que" detection is prompt-level (spec §9): the memory context block
  in agent modes instructs the model to call `memory_note`.
- Plain (non-agent) voice mode has no tools, so it uses transcript pattern
  matching instead (`detectRememberIntent` in `memoryStore.ts`): a matching
  final transcript is copied raw into `inbox/` before the assistant turn
  starts, with a `memory_note` event in the voice transcript log and a
  `[memory] saved to the memory inbox` console line. Patterns are
  second-person only ("retiens", "rappelle-toi", "tu te rappelles"…) so the
  user reminiscing ("je me souviens de…") does not trigger a note.

## Post-M1 fixes (from live voice testing, 2026-07-12)

Live agent-mode voice testing surfaced three gaps, fixed the same day:

- **Voice agent turns had no conversation history** (a Phase 7 leftover: each
  turn was standalone). This broke tier-1 working memory in that mode — the
  model could not resolve "consigne-le" from the previous turn and forgot
  in-session instructions. `runAgentLoop` now accepts optional
  `priorMessages`; voice agent turns pass the session history behind a
  transient instruction preamble, and the session stores raw transcripts
  instead of fully wrapped prompts.
- **Remember-intent safety net in agent mode**: if a turn's transcript matches
  `detectRememberIntent` but the model never called `memory_note`, the raw
  transcript is written to `inbox/` after the loop (source
  `voice remember-intent fallback`), so a spoken "c'est noté" can no longer
  be a lie.
- **Tool instructions now survive an empty index**: `buildMemoryContextBlock`
  with `withToolInstructions` emits the memory_read/memory_note guidance even
  when `MEMORY.md` has no entries — the very first "retiens que" happens
  before any memory exists. The instructions also state that durable
  preferences and standing instructions count as memories, and that the model
  must never claim it will remember without calling the tool.

`prompts/persona.md` additionally pins French informal address ("tu"), which
live testing showed drifting back to "vous" between turns.

## Verification

```bash
npm run build
npm test          # 12 suites, 65 tests — all passing
node dist/cli.js memory list
node dist/cli.js memory show <id>
```

All passed after implementation, including a real round-trip: layout created
at `~/.llmtest/memory/`, a hand-written fact read back via `memory show`.
