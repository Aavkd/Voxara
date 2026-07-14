# Phase C4: Resident Service, Local API, and Presence Layer

> **Status: agreed design (2026-07-14) — source of truth for implementation.**
> Converged on between Alexy and Claude on 2026-07-14. Coding agents
> implementing this phase must follow this specification. If an implementation
> constraint forces a deviation, update this document in the same change.
>
> **Priority note:** this phase is pulled ahead of C1 (reminders + contextual
> session opening). Rationale: today the entire experience — including voice —
> lives inside a terminal process that the user must start by hand, alongside
> two or three sidecar terminals. Every companion feature planned in
> [companion-roadmap.md](companion-roadmap.md) (reminders, wake word, briefing,
> remote web app) presupposes a Voxara that is *already there*. This phase
> builds that: a resident service owning the sidecars and the sessions, a
> local API, and a minimal Windows presence layer (tray icon, global hotkey,
> native notifications). C1 lands immediately after, on top of it.

## 1. Product intent

Voxara stops being "the process inside my terminal" and becomes a resident
local service. One command (or Windows startup) brings everything up: STT,
TTS, browser bridge, desktop host, and the service itself. From then on:

- A **tray icon** shows Voxara's state at a glance (asleep / listening /
  thinking / speaking) and gives one-click mute, interrupt, and session start.
- A **global hotkey** starts or mutes the voice session from anywhere, without
  focusing any window.
- **Native Windows notifications** announce background-task deliveries and
  approval requests — no more reading the terminal to know a delegated task
  finished or that the pilot is waiting for a yes.
- The **terminal keeps working exactly as today**: every existing command runs
  unchanged, with or without the service. When the service is running, the CLI
  attaches to it instead of duplicating it.

This phase also quietly builds the first half of the remote web app
(roadmap §5.3): the local API surface it introduces is the same one a web
front will consume later.

## 2. Goals

1. Extract the conversational core (session loops, tool registry, delivery
   drain, control channels, delegation service) into host-independent modules
   consumable by three hosts: the standalone CLI (today's behavior), the
   resident service, and — later — a web/Electron front.
2. A `service` command family: run the service, query it, stop it, diagnose
   it, install/uninstall Windows autostart.
3. Sidecar supervision: the service starts, health-checks, and restarts the
   configured sidecars (faster-whisper STT; optionally Qwen3-TTS). No more
   manual `npm run stt:start` terminal.
4. A localhost API (HTTP + WebSocket events) over which clients observe and
   drive sessions, receive deliveries and approval requests, and answer them.
5. CLI attach mode: `chat`, `agent-chat`, and `voice-chat` detect a running
   service and become thin clients of it; without a service they run
   standalone, byte-for-byte like today.
6. A Windows tray helper owned by the service: state icon, context menu,
   global hotkey, notifications, and approval dialogs.
7. A **runtime settings layer**: the usage choices currently frozen in `.env`
   (microphone device, TTS engine/voice, LLM provider and model, default
   tools, control trust level, …) become live settings — persisted, readable
   and writable over the API, adjustable from the tray, applied without
   restarting the service. Secrets and security *boundaries* stay in `.env`
   (§11.4).

## 3. Non-goals

- **No remote/network exposure.** Everything binds to `127.0.0.1` only. The
  remote web app (auth, TLS, phone access) is a later phase that reuses this
  API behind a proper gateway.
- **No web front, no Electron app** in this phase. The API is designed so they
  bolt on without core changes; building them is future work.
- **No wake word.** But C4 removes its biggest blocker: after C4 the always-on
  owner process exists, so the wake-word phase becomes "add a detector",
  not "rework the capture lifecycle".
- **No new conversational features.** Reminders, briefing, session opening
  stay in C1/C5. C4 is pure platform/UX work.
- **No cross-platform tray.** The tray helper is Windows-only, like the
  desktop host. The service itself stays platform-neutral where the code
  already is.

## 4. Hard compatibility requirements

These are acceptance criteria, not aspirations:

- **R1.** `npm run dev -- chat|agent-chat|voice-chat` (and every other
  existing command) works with **no service running**, with behavior
  identical to before this phase. The core-extraction refactor must be a pure
  restructuring from the standalone user's point of view.
- **R2.** Standalone mode remains first-class permanently — not a deprecation
  path. Tests must cover both hosts of every extracted session core.
- **R3.** The existing sidecar scripts (`npm run stt:start`, etc.) keep
  working for manual use; supervision is a layer on top, not a replacement.
- **R4.** No behavior change for the Chrome extension or the desktop host:
  the bridge and host move ownership (session → service) but keep their
  protocols, ports, and token files.

## 5. Architecture overview

```text
┌────────────────────────── voxara service (one process) ─────────────────────────┐
│  core (extracted library)                                                       │
│    session manager ── text sessions ── voice session (mic owner)                │
│    agent loop · tool registry · memory · delegation service · pilot             │
│    delivery queue drain · control policy · audit log                            │
│  channels owned by the service                                                  │
│    browser bridge :7863 (unchanged) · desktop host (stdio, unchanged)           │
│    sidecar supervisor (STT :7862, TTS :7861) · tray helper (stdio, new)         │
│  local API :7864 (127.0.0.1 only, token)                                        │
│    HTTP request/response  +  WS /events stream                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
        ▲                    ▲                        ▲
   CLI attached         tray helper              future web front /
  (chat/voice-chat)   (child process)              Electron app

Standalone CLI (no service): hosts the same core in-process — today's behavior.
```

### 5.1 Core extraction — the real work of this phase

Today `src/commands/voiceChat.ts` (~1600 lines) and `agentChat.ts` own their
loops end-to-end, mixing session logic with terminal I/O (readline, chalk,
ora). The extraction rule:

- **Session cores emit events and accept commands; they never touch the
  console.** New modules (suggested layout — implementers may adjust names,
  not the boundary):
  - `src/service/sessionCore.ts` — shared session state machine: transcript,
    agent-loop invocation, tool wiring, delivery drain at turn boundaries,
    approval brokering.
  - `src/service/voiceSessionCore.ts` — the voice loop (capture, VAD, STT,
    TTS, barge-in) reusing `src/audio/*` and `src/speech/*` unchanged,
    emitting `state` events (`idle|listening|thinking|speaking|paused`) and
    transcript segments instead of printing them.
  - `src/service/events.ts` — typed event union shared by core, API, and
    clients.
- The standalone CLI commands become thin hosts: they instantiate the same
  core in-process and render its events with the exact same terminal output
  as today (R1). The service hosts the same cores behind the API.
- Slash-command handling (`/mute`, `/tools`, `/provider`, …) moves into the
  core as a command interface, so the CLI, the API, and the tray all invoke
  the same implementations.

### 5.2 Ownership moves

Owned per-session today, owned by the service after C4 (and by the standalone
process when no service is involved):

- Browser bridge server (`:7863`) — starts with the service, not with each
  agent session; the extension therefore stays connected all day.
- Desktop host helper — same move; refs generation semantics unchanged.
- Delivery queue drain — the service watches for pending deliveries even with
  no session open (this is what makes tray notifications possible, and what
  C1's reminders will ride on).

## 6. The service process

### 6.1 Lifecycle and single instance

- `llmtest service run` — runs the service in the foreground (the actual
  process; this is what autostart launches).
- `llmtest service start` / `stop` / `status` — convenience wrappers: spawn
  detached, signal shutdown via the API, query state.
- Single instance enforced by a lockfile under the state root
  (`~/.llmtest/state/service/service.lock`) containing the pid + port,
  validated with the existing `isPidAlive` from `taskStore`. A stale lock is
  reclaimed silently.
- Graceful shutdown: stop accepting API calls, end the voice session cleanly
  (flush TTS, release mic), stop the tray helper, stop supervised sidecars
  it started (never ones it merely found running), release the lock.

### 6.2 Sidecar supervision

Config-driven list; each entry has a name, a start command, a health URL, and
a restart policy:

| Sidecar | Health | Started by service when |
| --- | --- | --- |
| faster-whisper STT (`:7862`) | `GET /health` | `SERVICE_SUPERVISE_STT=true` (default) and not already healthy |
| Qwen3-TTS (`:7861`) | `GET /health` | `SERVICE_SUPERVISE_TTS=true` (default **false** — Piper/Supertonic need no sidecar) |

- On boot: probe health first; **adopt** an already-running healthy sidecar
  (do not spawn a duplicate, do not stop it on shutdown — R3).
- Spawn uses the same underlying PowerShell start scripts as the npm scripts.
- Restart with exponential backoff (base 2 s, cap 60 s, give up after 5
  consecutive failures → sidecar marked `failed`, surfaced in `service
  status`, `control doctor`, and a tray notification).
- Health is re-probed on a slow interval and before each session start.

### 6.3 Windows autostart

- `llmtest service install` — creates a Startup-folder shortcut (or
  `schtasks` entry; implementer's choice, documented in the code) that runs
  `node dist/cli.js service run` hidden. `service uninstall` removes it.
- Autostart is opt-in; `install` prints exactly what it created and where.

## 7. Local API

### 7.1 Transport and authentication

- One `http.Server` bound to `127.0.0.1:${SERVICE_PORT}` (default **7864**;
  7861 TTS, 7862 STT, 7863 bridge are taken).
- **Token**: same pattern as the bridge pairing token —
  `~/.llmtest/state/service/service-token`, generated on first need,
  `base64url`, ≥ 16 chars. Local clients (CLI, tray) read it from disk; file
  ACLs on the user profile are the trust boundary, exactly like the bridge
  token. HTTP requests carry `Authorization: Bearer <token>`; the WS `/events`
  connection sends a `hello` first frame with the token and is closed on
  mismatch (mirror `browserBridge.ts` discipline, including the hello
  timeout).
- All request/response bodies are JSON. Correlation ids on WS frames follow
  the bridge convention.

### 7.2 HTTP endpoints (request/response)

| Endpoint | Role |
| --- | --- |
| `GET /health` | Unauthenticated liveness (`{ ok, version, uptime }`) — used by `service status` and lock reclaim. |
| `GET /status` | Full picture: sidecar health, active sessions, pending deliveries count, pending approvals, tray/hotkey state, active provider+model. |
| `POST /sessions` | Create a session: `{ kind: "text"\|"voice", options }` (tools, sandbox, docs — the same options the CLI flags express). Voice: 409 if a voice session already exists (mic single ownership, §8.2). |
| `GET /sessions` / `GET /sessions/:id` | List / inspect (state, transcript tail, options). |
| `POST /sessions/:id/input` | Send a user text turn. |
| `POST /sessions/:id/command` | Session commands — the slash-command set: `mute`, `unmute`, `interrupt`, `set_tools`, `set_provider`, `set_model`, `set_tts`, … |
| `DELETE /sessions/:id` | End the session cleanly. |
| `GET /approvals` | Pending approval requests (control confirmations, `delegate_approve`-style gates, pilot fast-lane). |
| `POST /approvals/:id` | `{ decision: "approve"\|"deny", note? }`. Forwarded to the same policy code paths that terminal confirmation uses today — the API introduces **no new approval semantics** and cannot widen a grant (C2/C3 rules hold by construction). |
| `GET /deliveries` | Pending deliveries (peek — does not mark delivered). |
| `GET /settings` | The resolved runtime settings document with per-key provenance (`settings` / `env` / `default`). Secrets are not part of the document (§11.4) — there is nothing to redact. |
| `PUT /settings` | Partial update `{ key: value, … }`. Validated against the settings catalog (§11.2); unknown keys and invalid values are rejected as a whole (no partial apply). Security-loosening changes go through the approval gate (§11.5). |
| `GET /settings/options` | Enumerated choices for choice-typed settings: microphone devices (existing voice-check enumeration), TTS engines and their installed voices, providers, models of the active provider (existing `models` listing), trust levels. Computed between turns, never during capture. |
| `POST /shutdown` | Graceful stop (used by `service stop`). |

### 7.3 WS `/events` stream

Clients subscribe (optionally filtered by session id) and receive the typed
event union:

- `session.created` / `session.ended` / `session.state`
  (`idle|listening|thinking|speaking|paused`)
- `session.transcript` — user and assistant segments as they exist today in
  the terminal rendering (streaming segments included)
- `session.tool` — tool start/finish summaries (what agent-chat prints today)
- `approval.requested` / `approval.resolved`
- `delivery.queued` / `delivery.delivered`
- `settings.changed` — key, new value, origin (`api`, `tray`, `session`), so
  every attached client (and the tray checkmarks) stays in sync
- `sidecar.health` — transitions only
- `service.stopping`

Events are fan-out; a slow or dead client is dropped, never blocks the voice
hot path. **No event emission may add work inside the capture/synthesis
loop** beyond pushing to an in-memory queue — same latency rule the memory
spec imposes.

## 8. Sessions under the service

### 8.1 Text sessions

Straightforward: the session core runs in the service; any number of
observers on `/events`; input via `POST /sessions/:id/input`. An attached CLI
renders exactly what standalone renders.

### 8.2 The voice session and mic ownership

- **At most one voice session exists at a time**, service-wide. The service
  owns capture and playback (it runs on the user's machine).
- Attaching (`voice-chat` with a service running) means: mirror the live
  transcript and state, send commands and typed text. Detaching the terminal
  does **not** end the voice session — it keeps running headless, visible in
  the tray. Ending it is an explicit command (`/exit` from an attached
  client, tray menu, or `DELETE /sessions/:id`).
- Standalone `voice-chat` (no service, or `--standalone`) behaves like today.
  If a service **is** running a voice session, standalone startup fails fast
  with a clear message (two processes must not fight over the mic); the STT
  HTTP sidecar itself is stateless and shared safely.

### 8.3 Deliveries and approvals without a session

This is the UX payoff of §5.2's drain move:

- A delivery arriving while a session is active: unchanged (turn-boundary
  announcement — the C2a/C2d behavior).
- A delivery arriving with **no active session**: the service emits
  `delivery.queued` and the tray shows a notification ("tâche terminée : …").
  The delivery **stays pending** for conversational delivery at the next
  session — the notification informs, the conversation delivers. (C1 will
  refine per-kind policies, e.g. reminders that the toast alone satisfies.)
- An approval request with no session: tray notification + dialog (§9.3).
  Approvals never time out into a default; they wait, and re-surface at the
  next session start (existing behavior preserved).

## 9. Windows tray helper

### 9.1 Pattern

A persistent PowerShell helper, exactly like the desktop host
(`src/control/desktopHost.ts`): static script asset owned by the application,
written verbatim to the state root at spawn, JSON lines over stdio with
correlation ids, automatic respawn by the service on crash. Untrusted strings
(task titles, approval descriptions) travel as JSON **data**, never
interpolated into code — same security note as the desktop host header.

The helper is a **child of the service**: service dies ⇒ tray disappears
(truthful presence indicator). It uses WinForms `NotifyIcon` and a standard
message loop.

### 9.2 Surface

- **State icon**: distinct icons for `asleep` (service up, no voice session),
  `listening`, `thinking`, `speaking`, `paused` (mic muted / pilot suspended).
  Ship small static `.ico` assets under `assets/tray/`.
- **Context menu**: Start/End voice session · Mute/Unmute · Interrupt ·
  Quick settings (below) · Status summary · Quit Voxara (graceful service
  stop). Menu entries map 1:1 onto API commands; the helper holds no logic.
- **Quick-settings submenu**: radio/check items built from
  `GET /settings/options` and kept in sync via `settings.changed` events:
  - **Microphone** — device picker (the answer to "which mic is in use" is
    always one glance away);
  - **Modèle** — provider + model picker;
  - **Voix** — TTS engine and voice;
  - **Outils** — default tool access for new sessions (`all` / `none`);
  - **Confiance** — control trust level (`confirm_each` / `session_grant` /
    `auto`); loosening prompts the §11.5 confirmation dialog.
  Every selection is a plain `PUT /settings` — the helper renders choices and
  reports clicks, nothing more. Anything beyond these five (VAD tuning,
  chunking, timeouts, …) is API-only until the web front exists.
- **Global hotkey** (`RegisterHotKey` P/Invoke in the helper's message loop):
  default `Ctrl+Alt+V` — starts the voice session if none, toggles mute if
  one is running. Configurable via `SERVICE_HOTKEY`; collision with an
  already-registered system hotkey is reported at spawn, not silent.
- **Notifications**: `NotifyIcon` balloon/toast for `delivery.queued` (no
  active session), `approval.requested`, sidecar failures, service errors.
- **Approval dialog**: clicking an approval notification (or menu entry)
  opens a minimal always-on-top WinForms dialog rendering the approval
  description verbatim with **Approve / Deny** buttons; the answer flows back
  over stdio → service → the same `POST /approvals/:id` code path. No
  free-text, no scope widening — the dialog can only answer the specific
  pending request.

### 9.3 Explicitly out of scope for the tray

No transcript rendering, no full settings panel (only the §9.2 quick-settings
submenu), no chat input. The tray is presence, interrupts, and quick switches
only; conversation and full-configuration UIs are the CLI today and the web
front later.

## 10. CLI attach mode

- `chat`, `agent-chat`, `voice-chat` gain `--attach` / `--standalone` flags.
  Default: **auto** — if the service is reachable (lockfile + `/health`),
  attach and print one line saying so; otherwise run standalone silently.
- Attached `chat`/`agent-chat`: create (or join with `--session <id>`) a text
  session; render `/events`; forward input and slash commands.
- Attached `voice-chat`: join the voice session (creating it if absent);
  mirror transcript/state; `/exit` ends the session, `Ctrl+C` detaches
  leaving it running (printed clearly at attach time).
- `service status` shows sessions with ids so a terminal can re-attach.
- Everything renders through the same event-rendering module the standalone
  host uses — one renderer, two transports.

## 11. Runtime settings and configuration

### 11.1 The settings store

A single JSON document at `~/.llmtest/settings.json` (override:
`LLMTEST_SETTINGS_PATH`, for tests), written atomically
(`atomicWriteFileSync` from `statePaths`). It holds **only keys the user has
explicitly changed** — it starts empty and never mirrors defaults, so `.env`
and defaults keep meaning something. Human-readable and hand-editable, in
keeping with the Markdown-memory philosophy; the service watches/reloads it
on external edit.

### 11.2 The settings catalog

Settings are declared in one typed catalog (key, type, enum values or
validator, effect timing, security class) that drives `PUT` validation,
`GET /settings/options`, the tray submenu, and the future web front. v1
catalog:

| Group | Settings | Effect |
| --- | --- | --- |
| Audio in | microphone device; VAD threshold / silence ms; barge-in on/off | mic device & VAD: applied at the next listening window (capture restart between turns — never mid-utterance) |
| Voice out | TTS engine (`piper`/`supertonic`/`qwen3`); voice per engine | hot (the `/tts` session command already does this live) |
| LLM | provider; model; vision provider | hot — next turn |
| Agent | default tools for new sessions (`all`/`none`/list); agent max steps | new sessions; a running session keeps its `/tools` state |
| Control | trust level (`confirm_each`/`session_grant`/`auto`); `control_code` auto | hot, gated (§11.5) |
| Delegation | enabled; default backend | hot, enabling is gated (§11.5) |
| Service | hotkey; sidecar supervision toggles; tray on/off | hotkey/tray: helper respawn; supervision: next probe cycle |

Effect timing is part of the catalog and returned by `GET /settings` so UIs
can say "prend effet au prochain tour" honestly. Nothing in the catalog
requires a service restart; values that would (ports, paths) are deliberately
not settings (§11.4).

### 11.3 Precedence

Resolution order (highest → lowest) becomes:

1. session-scoped state (slash commands like `/model`, `/tts` — ephemeral,
   dies with the session; unchanged);
2. CLI flag overrides (per-invocation; unchanged);
3. **`settings.json`** — the user's most recent deliberate choice, made in a
   UI; it must win over static files or the tray would look broken;
4. process environment variables;
5. local `.env`, then `~/.llmtest/.env`;
6. defaults.

`loadConfig` in `src/config/loader.ts` gains the settings source, and the
`config` command's provenance annotation shows `settings` alongside the
existing sources. Standalone CLI reads the same file — a mic picked in the
tray is the mic `voice-chat --standalone` uses tomorrow (one source of
truth, both hosts).

### 11.4 What is *not* a runtime setting

- **Secrets**: API keys and tokens stay in `.env`/environment only. They are
  not in the settings document, never travel through the API in either
  direction, and the tray never sees them.
- **Security boundaries**: `DELEGATION_ALLOWED_ROOTS`,
  `DELEGATION_ALLOWED_PROGRAMS`, service/bridge ports and bind address. A
  mutable-over-API boundary is no boundary; widening these must remain a
  deliberate file edit outside any UI surface.
- Structural paths (state dir, memory dir, prompts dir).

### 11.5 Security-sensitive settings

Changes are classified by direction:

- **Tightening** (e.g. trust level `auto` → `confirm_each`, disabling
  delegation, `control_code` auto → off): applied immediately, no
  confirmation, logged.
- **Loosening** (trust level toward `auto`, `control_code` auto on, enabling
  delegation): routed through the **same approval mechanism as control
  actions** — an `approval.requested` event answered in an attached session
  or the tray dialog, wording the change explicitly ("passer le niveau de
  confiance à auto : les actions couvertes ne demanderont plus de
  confirmation"). Applied only on explicit yes, and recorded in the control
  audit log under `~/.llmtest/state/control/`. A loosening `PUT` from a
  client is therefore asynchronous: `202` + pending approval, not `200`.

This keeps the §12 invariant honest: the API and tray add convenience, never
a quieter path to more power.

### 11.6 New `.env` keys

Loader additions (documented in `.env.example`) — these are the *defaults*
under the §11.3 precedence, all overridable at runtime except the port:

```env
SERVICE_PORT=7864
SERVICE_SUPERVISE_STT=true
SERVICE_SUPERVISE_TTS=false
SERVICE_TRAY=true            # Windows only; ignored elsewhere
SERVICE_HOTKEY=ctrl+alt+v
```

Defaults chosen so `service run` on a standard setup (Piper TTS,
faster-whisper STT) brings up everything a voice session needs with zero
extra terminals.

## 12. Security model

- Bind `127.0.0.1` only; never `0.0.0.0`. No CORS headers (a browser page
  must not be able to call the API; the future web front gets its own
  deliberate gateway phase).
- Token auth on every endpoint except `GET /health`; WS hello discipline as
  §7.1. Token file lives under the user profile, like the bridge token.
- The API adds **no capability** that the terminal did not have: approvals go
  through the existing policy code, control/audit logging under
  `~/.llmtest/state/control/` is unchanged, delegation gates are unchanged.
- The tray helper script is a static asset; model output never reaches it as
  code (§9.1).

## 13. Implementation slices

Each slice lands green (`npm test`) and standalone-compatible (R1) on its own.

### C4a — core extraction + service skeleton

Extract session cores (§5.1) with the standalone CLI re-hosted on them first
(this is the R1 proof, before any service exists). The settings store,
catalog, and loader precedence (§11.1–§11.3) land here too — they benefit the
standalone CLI on their own, and `config` gains the `settings` provenance.
Then: `service run|start|stop|status`, lockfile, `/health` + `/status` +
`/shutdown`, token, sidecar supervisor (§6.2), `service doctor` (or fold into
`control doctor`). No sessions over the API yet.

### C4b — session API + CLI attach (text)

Session manager in the service; §7.2 session/approval/delivery/settings
endpoints (including `GET /settings/options` and the §11.5 approval-gated
loosening flow) and the §7.3 event stream; attach mode for
`chat`/`agent-chat`; approvals and deliveries over the API;
bridge/desktop-host ownership moves to the service (§5.2).

### C4c — voice session under the service

`voiceSessionCore` extraction (the largest single item — do it as its own
slice deliberately); mic single-ownership rules (§8.2); `voice-chat` attach
mode; headless voice session lifecycle.

### C4d — tray helper + hotkey + notifications + autostart

§9 in full — including the quick-settings submenu driven by
`GET /settings/options` and `settings.changed` — plus
`service install|uninstall` (§6.3).

Recommended order is as listed; C4d depends on C4b (approvals/deliveries/
events) and is far more useful after C4c (voice states), but its
notification-only half could land after C4b if sequencing demands it.

### Deferred to later phases

- Web front (roadmap §5.3 second half) — consumes this API; needs its own
  gateway/auth spec before any non-localhost exposure.
- Electron desktop app — a packaging of the web front; explicitly after it.
- Wake word — becomes "detector inside the service voice lifecycle" (roadmap
  §2.4) once C4c exists.

## 14. Testing

Project conventions hold: Jest, no API keys, no mic, no GPU, no real LLM.

- **Session cores**: unit-test against fake providers/audio boundaries — the
  extraction should *increase* testability of what is currently locked
  inside `voiceChat.ts`.
- **API**: start the service on an ephemeral port (`SERVICE_PORT=0` supported
  for tests, like the bridge) with fake cores; exercise auth failures, hello
  timeout, session lifecycle, approval forwarding, event fan-out, slow-client
  drop.
- **Sidecar supervisor**: fake sidecar executables (pattern:
  `tests/fixtures/fakeDesktopHost.js`) — adoption of a healthy sidecar,
  restart backoff, give-up threshold.
- **Tray helper**: `spawnOverride` with a fake helper (desktop-host pattern);
  assert protocol frames for state changes, notifications, approval
  round-trips. The real PowerShell script gets a lint-level smoke test only.
- **Attach mode**: CLI client against a service fixture; assert identical
  rendering between standalone and attached transcripts for the same event
  sequence.
- **Settings**: precedence resolution across all six §11.3 layers (temp
  settings file + injected env); catalog validation (unknown key, bad enum,
  atomic reject of a partially invalid `PUT`); tightening applies instantly
  while loosening produces a pending approval and only applies after the
  approve; external file edit triggers reload + `settings.changed`; secrets
  and §11.4 boundary keys are absent from `GET /settings` and rejected by
  `PUT`.
- **R1 regression**: existing command tests must pass unmodified after C4a.
