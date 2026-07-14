# Companion Feature Roadmap

> **Status: agreed direction — source of truth for future feature work.**
> Converged on between Alexy and Claude on 2026-07-12. Nothing in this document is
> under construction yet: items are picked up one at a time, and each one gets its
> own phase spec (`docs/phase-*.md`) before implementation, following the existing
> phase-document convention. If priorities or scope change, update this document in
> the same change.

## 1. Where the project stands

Baseline as of 2026-07-12 (post audio phases 0–9 and memory phases M1–M3):

- Real-time French/English voice loop with adaptive VAD and barge-in.
- Local STT through the faster-whisper GPU sidecar; local TTS through Piper and
  Supertonic (primary, real-time) with Qwen3-TTS available for quality.
- Layered Markdown memory (index + facts + episodes) with consolidation and
  hygiene, per [memory-architecture-spec.md](memory-architecture-spec.md).
- Agent tool-use with a small tool set: calculator, sandboxed file read/write,
  current time, `memory_read`, `memory_note`.

The theme of every item below: move Voxara from **voice chatbot** to
**companion** — useful in the real world, present without being summoned, and
natural in conversation.

## 2. Roadmap items

Ordered by priority. Priorities reflect value-for-effort as agreed, not a strict
build order — but 2.1 and 2.2 are the intended starting point.

### 2.1 Real-world tools — priority 1

The current tool set is demo-grade. Three tool families, in order of impact:

**a) Reminders and timers.** "Rappelle-moi dans 20 minutes de sortir le plat."

- A `reminder_set` / `reminder_list` / `reminder_cancel` tool family.
- Persistent scheduler state under `~/.llmtest/.state/` (JSON), so reminders
  survive restarts; a lightweight in-process ticker checks due entries.
- When a reminder fires during a voice session, it is spoken through the
  existing TTS loop; when no session is active, it is delivered at the start of
  the next session ("pendant ton absence, tu avais demandé…").
- Natural fit with memory: recurring or standing reminders can be promoted to
  facts by the existing consolidation pipeline.

**b) Web search and weather.** The most common real-world question for a voice
assistant.

- Prefer a local SearXNG instance (consistent with local-first), with a plain
  HTTP API fallback as a config option.
- Results are summarized by the LLM before speaking — never read raw result
  lists aloud.

**c) Local machine control.** Open an app or file, adjust system volume.

- ~~PowerShell-backed actions on Windows.~~
- ~~Must go through an explicit allowlist (same spirit as the file-tool sandbox):
  the tool exposes named actions, never arbitrary shell execution.~~
- **Superseded (2026-07-12)** by
  [phase-c3-computer-control.md](phase-c3-computer-control.md): the allowlist
  design was rejected as too deterministic for the agentic architecture.
  Machine control is now general typed intents governed by an effect-level
  policy (observe / reversible / sensitive) with configurable trust levels.

### 2.2 Contextual session opening — priority 1

Today Voxara starts every session cold. The memory system already stores one
episode per past conversation — use it:

- At `voice-chat` (and `agent-chat`) startup, inject the most recent episode
  (or its index line plus a `memory_read`) into the opening prompt so the
  companion can open with continuity: "la dernière fois on parlait de X, ça a
  avancé ?".
- Mostly prompt-side work; no new storage. Must respect the memory spec's rule
  that the voice hot path is never slowed by memory work (read once at startup,
  outside the turn loop).

### 2.3 Backchannel (perceived latency) — priority 2

Mask the LLM + TTS gap with short pre-generated acknowledgements:

- A small pool of pre-synthesized filler clips ("hmm…", "voyons…", "bonne
  question…") in the active voice, played immediately after end-of-utterance is
  detected, while the real response is being generated.
- Fillers must be interruptible by the real response and respect barge-in: if
  the user speaks again, the filler is cut exactly like normal TTS output.
- Vary and rate-limit fillers (not on every turn) so it stays natural.

*Dropped from this theme:* fast/quality TTS routing. Piper and Supertonic are
already the primary engines in daily use, so a routing layer adds no value —
decision 2026-07-12.

### 2.4 Wake word — priority 3

The step from "I launch a session" to "it is always there":

- "Voxara ?" (exact phrase TBD) detected by openWakeWord or Porcupine on a
  permanently open mic stream; the existing adaptive-VAD capture is the base.
- Detection runs fully locally and gates everything downstream: no audio
  leaves the wake-word detector until the wake word fires, and STT only starts
  after it.
- Requires rework of the capture lifecycle (today capture belongs to a
  session); the always-on listener becomes the owner and spawns sessions.
- Sleep behavior TBD in the phase spec: return-to-idle timeout, explicit
  "c'est bon, merci" dismissal, or both.

### 2.5 Vision — priority 4

> **Specified (2026-07-12):** realized as slice C3a of
> [phase-c3-computer-control.md](phase-c3-computer-control.md), which also
> covers interactive browser/desktop control (C3b/C3c). That spec is the
> source of truth for this item.

"Regarde mon écran et dis-moi ce qui cloche."

- A `screenshot` tool that captures the screen (or a chosen window) and passes
  the image to a multimodal provider.
- Gemini already supports images; Ollama covers the local path (qwen2.5-vl,
  llava). Requires extending the provider interface to image content parts —
  the largest piece of this item.
- Webcam input is out of scope until screen vision has proven itself.

## 3. Explicitly deferred (do not build)

- **Memory M4 (semantic retrieval).** Gated by the trigger in
  [memory-architecture-spec.md §8.4](memory-architecture-spec.md): only if
  `MEMORY.md` regularly presses its 80-line budget despite M3, or facts become
  too large to inject. The trigger has not fired.
- **Desktop avatar / cosmetic UI.** Cosmetic relative to the presence features
  above; revisit only after 2.1–2.4 exist. (Distinct from the remote web app in
  §5.3, which is about access from anywhere and *is* planned.)
- **Speaker recognition (voiceprint / guest mode).** Considered on 2026-07-12
  and pushed far out — not a priority while there is exactly one user at the mic.
- **Home automation (Home Assistant bridge).** Considered on 2026-07-12 and
  deferred — few connected devices at home today; revisit if that changes.

## 4. Sequencing and dependencies

```
2.1a reminders ─┐
2.2 session opening ─┴─ first slice — spec: phase-c1-reminders-continuity.md
2.3 backchannel ──────── independent, small, anytime
2.1b search / 2.1c local control ── independent tool additions
2.4 wake word ────────── after the voice loop is otherwise stable
2.5 vision ───────────── independent, but provider-interface work first
```

**Priority update (2026-07-12):** the agentic layer comes first. Coding-agent
delegation (realizing §5.1; spec:
[phase-c2-coding-agent-delegation.md](phase-c2-coding-agent-delegation.md)) is
pulled ahead of the reminders slice. Its first implementation slice (C2a) builds
the shared engine primitives specified in phase C1 — task store, delivery queue,
background dispatch — which C1's reminders and session opening then reuse when
they land afterwards.

**Priority update (2026-07-14):** the platform/UX layer comes before C1. The
resident service, local API, and Windows presence layer (tray, global hotkey,
native notifications) are specified in
[phase-c4-resident-service.md](phase-c4-resident-service.md) and are the next
implementation work. Rationale: every presence feature (reminders §2.1a, wake
word §2.4, briefing §5.2, remote web app §5.3) presupposes a Voxara that is
already running rather than a terminal session started by hand. C4 also
realizes the API half of §5.3. The standalone terminal experience remains
first-class and unchanged (hard requirement R1 of the C4 spec). C1 lands
immediately after C4, delivering reminders through the service's
always-available delivery channel.

Testing follows the project convention: Jest with all LLM (and TTS/STT) calls
mocked; scheduler and tool logic tested against temp directories and fake
clocks. Anything touching the voice hot path must not add latency to the
turn loop — same constraint the memory spec imposes.

## 5. Horizon 2 — agreed directions (2026-07-12)

Second wave, agreed after the §2 items. Same rules apply: one phase spec per
item before implementation; this section records intent and priority, not
design. Ordered by Alexy's expressed priority.

### 5.1 Asynchronous tool execution (background agents) — architectural principle

The core long-term vision for the agent loop, seeded by the M2 memory agent:
**most tool calls run in the background, off the conversational hot path.**
File reads/writes/edits, web searches, opening programs, document work — the
voice agent acknowledges immediately ("je m'en occupe"), dispatches the work to
a background worker, and the conversation flow stays near-instant. Results come
back through the same channel as reminders (§2.1a): vocalized when ready if a
session is active, delivered at next session start otherwise. Only tools that
are both instant and needed to answer the current question (e.g. current time,
memory_read) stay synchronous.

This is not one feature but a principle that shapes the agent loop — it should
be designed before the §2.1 tool families grow, so new tools are born async.

First concrete realization: coding-agent delegation (Codex CLI / Claude Code as
Voxara's "hands"), specified in
[phase-c2-coding-agent-delegation.md](phase-c2-coding-agent-delegation.md).

### 5.2 Briefing + tracked topics

Extends the contextual session opening (§2.2): at the first session of the day,
Voxara opens with a briefing — today's reminders, open threads from recent
episodes, weather, and **digests of user-defined tracked topics**: interests
Alexy registers ("suis l'actu de X"), each with its own cadence (daily or
weekly). Topic research runs as a background job (§5.1) using the web-search
tool (§2.1b); digests are staged and folded into the next briefing.

### 5.3 Remote web app — short/medium term

A server mode exposing the companion (same memory, same persona) behind an API,
plus a web front usable from a phone or anywhere. Alexy has deployed multiple
fronts on Vercel and runs his own server machine, so hosting is a solved
problem — the work is the API surface and session/auth model. Text first;
remote voice (browser mic → STT sidecar) as a follow-up.

> **Partially realized (2026-07-14):** the local API surface is built by
> phase C4 ([phase-c4-resident-service.md](phase-c4-resident-service.md)),
> localhost-only. What remains of this item is the exposure layer (gateway,
> auth, TLS) and the web front itself — a later phase, possibly followed by
> an Electron packaging of the same front.

### 5.4 Off-the-record mode

"Ne retiens pas ça" — the conversation continues but the session (or a marked
span of it) is excluded from M2 consolidation: no episode, no fact promotion,
no inbox note. A trust feature for a companion that hears everything. Small
change to the consolidation pipeline; the phase spec must define span vs
whole-session semantics.

### 5.5 Personal RAG

Promote `src/rag/` from evaluation harness to a real personal knowledge base:
index a folder of Alexy's documents and answer over it in voice ("qu'est-ce que
dit mon contrat sur X ?"). Shares retrieval infrastructure with memory M4 if
its gate ever fires.

### 5.6 Voice identity + audio post-processing

Two halves, buildable independently:

- **Custom voice**: train a dedicated Piper voice so Voxara has its own voice
  rather than a stock one. Fully local.
- **FX chain**: a configurable audio post-processing stage after TTS synthesis
  — flanger, distortion, reverb, and other effects, user-customizable
  (per-effect parameters, orderable chain). Runs on the synthesized buffer
  before playback; must not add perceptible latency with Piper/Supertonic.

### 5.7 Self-evaluation (accepted)

Reuse the existing evaluation harness (`prompts/judge*.md`, faithfulness
checks) on real conversation transcripts, as a periodic background job:
score recent sessions (verbosity in voice, tone, hallucinations), produce a
report, and suggest — never auto-apply — adjustments to `prompts/persona.md`.

### 5.8 Emotional layer (accepted)

Detect (sentiment of transcribed text first; audio prosody — energy, tempo —
later, building on the VAD's signal analysis) and adapt (response style, TTS
parameters). Combined with memory, gives mood continuity across sessions
("hier tu semblais frustré par X, ça va mieux ?").
