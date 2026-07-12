# Phase C3: Computer Control — Screen Vision and Interactive Control

> **Status: Slice C3a implemented and live-validated 2026-07-12.
> Slices C3b/C3c remain designed. Priority (decision
> 2026-07-12): C3 is implemented next — before the remaining delegation
> slices C2d-2 and C2d-5 (C2d-1/3/4 are already shipped).** This document is
> the source of truth for the feature. Coding agents implementing this phase must
> follow this specification; if an implementation constraint forces a
> deviation, update this document in the same change.
>
> This phase realizes and **supersedes** two companion-roadmap items:
> [§2.5 Vision](companion-roadmap.md) (implemented as slice C3a) and
> [§2.1c Local machine control](companion-roadmap.md) (the allowlisted
> named-action design there is **rejected** — see §3, decision D1).
> It reuses the background-task foundation shipped in C2 (task store,
> delivery queue, turn-boundary voice announcements).

## 1. Product intent

Voxara can see the screen and act on the computer from a natural voice or text
request, without leaving the conversation:

> "Ouvre YouTube." — opens the site in the user's real browser.
>
> "On est sur la page du produit, clique sur « Ajouter au panier »." — clicks
> the element in the tab the user is looking at.
>
> "Regarde mon écran, c'est quoi cette erreur ?" — captures the screen, reads
> it with a vision-capable model, answers in voice.
>
> "Ferme Spotify." — closes the application.
>
> "Compare le prix de ce produit sur trois autres sites." — dispatches a
> background pilot that browses, then announces its findings at the next idle
> voice boundary.

Two lanes, chosen automatically by the conversational agent:

- **Fast lane (in-turn):** a unitary intention is a single tool call inside
  the existing agent loop. Interactive co-piloting ("clique là… maintenant
  descends… ouvre le troisième lien") is just consecutive fast-lane turns —
  there is deliberately **no separate "control mode"**.
- **Pilot lane (async):** a multi-step goal is dispatched to an internal
  background pilot agent, exactly like a C2 delegation: immediate
  acknowledgment, progress in the task store, result through the delivery
  queue. The real-time voice conversation is never blocked.

## 2. Goals

1. Let the conversational model observe the screen (full screen, a window, or
   a browser tab) and reason about it with a vision-capable provider.
2. Let it act on the user's **real** environment — the browser tabs and
   applications the user actually has open — through general, typed intents.
3. Keep the system malleable: any site, any application, any sequence. Safety
   comes from a policy that classifies intents by **effect level**, never from
   an enumeration of permitted actions.
4. Keep multi-step work off the conversational and voice hot paths (pilot
   lane), while keeping unitary actions fast enough to live in the turn.
5. Give the user an always-available kill-switch and automatic hand-back when
   they touch the mouse or keyboard during pilot activity.
6. Journal every executed intent for audit and for "qu'est-ce que tu viens de
   faire ?".

### Non-goals

- A fixed allowlist of named actions (rejected by design — §3 D1).
- Pixel-coordinate "computer use" driven by a vision model (SendInput on model
  coordinates). Deferred; the DOM (browser) and UI Automation (desktop) paths
  make it unnecessary for the target scenarios.
- Browsers other than Chrome/Chromium for the extension in this phase
  (Edge/Brave likely work as-is; verify later, do not build for them).
- Always-on screen watching. Every capture is on demand — a tool call by the
  model in service of a user request.
- Webcam input (roadmap: out of scope until screen vision has proven itself).
- OS-level sandboxing guarantees. As with C2 on Windows (§8.4 there), safety
  rests on the application policy layer, the approval gates, and the journal.
- Recovery of an in-flight pilot after the Voxara process dies. Interrupted
  pilots are reported on next startup (C2 recovery pattern) and may be retried.

## 3. Design decisions (2026-07-12)

Recorded so implementers do not re-litigate them:

- **D1 — No named-action allowlist.** The roadmap's §2.1c design (allowlisted
  `system_control` verbs) is rejected as too deterministic: it restricts the
  system and contradicts the agentic architecture. Instead: general typed
  intents + a policy that classifies each intent by effect level (§8), in the
  same spirit as `src/delegation/policy.ts`.
- **D2 — Hybrid executor.** Typed intents cover the common cases (observe,
  click, fill, navigate, tabs, open/close/focus apps, keys). A gated
  `control_code` fallback (generated PowerShell/JS) covers what no intent
  expresses, with the strictest gate. Intents are preferred; the fallback is
  explicit and never chosen for convenience.
- **D3 — Vision is provider-generic, Gemini first.** `ILLMProvider` and
  `Message` are extended to image content parts generically; the Google
  provider implements them first (reliable grounding, already the default
  provider). A local model (qwen2.5-vl via Ollama) plugs in later with no
  rework. The GPU already carries STT + TTS — local vision must not be assumed.
- **D4 — Browser control via a custom Chrome extension**, not CDP
  (`--remote-debugging-port`) and not a managed Playwright browser. The
  extension connects **out** to a localhost WebSocket server owned by the
  long-lived Voxara process (native messaging is designed for the inverse
  lifecycle and is not used). This gives access to the user's real tabs with
  no launch flags.
- **D5 — Two lanes, no mode.** Unitary intents run in-turn; multi-step goals
  run as an async internal pilot on the C2 task-store/delivery-queue
  foundation. No modal "control session" construct exists.
- **D6 — Trust levels are user configuration.** `confirm_each` |
  `session_grant` (default) | `auto`. See §8.2. Even `auto` journals
  everything and honors the kill-switch.
- **D7 — Slice order: C3a vision → C3b browser → C3c pilot + desktop.** Each
  slice ships user-visible value and is live-tested before the next.

## 4. User-facing behavior

### 4.1 Fast lane

1. The user asks for one observation or one action.
2. Voxara calls the matching tool (`screen_view`, `browser_read`,
   `browser_act`, `desktop_act`).
3. The policy classifies the intent (§8.1). Under the default
   `session_grant` trust level: observation is free; the first **acting**
   intent of a session asks once — "Je prends la main quand il faut pour
   cette session ?" — and an affirmative grants reversible actions for the
   rest of the session. Sensitive intents are confirmed individually with
   their concrete effect ("Je ferme Word ; il y a un document non enregistré
   — je confirme ?"), C2 §3.2 style: describe the effect, never ask a generic
   permission question.
4. The tool returns in-turn; Voxara answers naturally.

### 4.2 Pilot lane

1. The user states a goal that clearly needs several observe→act steps.
2. Voxara calls `pilot_task`; the service persists a task, starts the
   background pilot loop, and returns a task id immediately. Voxara
   acknowledges without waiting ("Je m'en occupe, je te dis quand c'est
   fait.").
3. The pilot publishes progress events to the task store. Completion,
   failure, or a needed approval goes through the delivery queue: spoken at
   an idle voice boundary, printed between text turns, or delivered at next
   startup — identical mechanics to C2 deliveries.
4. The conversation continues normally while the pilot works.

### 4.3 Kill-switch and hand-back

- "Stop" / "arrête" (and barge-in followed by such an utterance) cancels the
  running pilot **between steps immediately, and mid-step by aborting the
  in-flight bridge/UIA call**. `pilot_cancel` is the programmatic form.
- **User-input pause:** before every pilot action step, the pilot checks
  whether the user generated mouse/keyboard input since the step began
  (Windows `GetLastInputInfo`, polled — no global hook). If yes, the pilot
  pauses and a delivery announces: "Je te laisse la main, dis-moi quand je
  reprends." "Reprends" resumes; "annule" cancels.
- Session end revokes the session grant and cancels running pilots (with a
  startup report next time, C2-style).

### 4.4 Transparency

- "Qu'est-ce que tu as fait ?" is answerable from the journal (§8.3):
  Voxara reads the recent entries and summarizes.
- In voice, pilot actions are silent while running (no step-by-step
  narration); only grant requests, pauses, and results are spoken.

## 5. Architecture

```text
Conversational agent (agentLoop)
   │ fast lane: screen_view / browser_read / browser_act / desktop_act / control_code
   │ pilot lane: pilot_task / pilot_status / pilot_cancel
   ▼
Control service ──── control policy (effect levels × trust level) ──── journal
   │                      │
   │                      └── confirmation gates → conversational agent → user
   ▼
Executor (routes each intent to a channel)
   ├── Browser bridge ── WebSocket (localhost:7863, token) ── Chrome extension
   │                                                            ├── DOM snapshot / act
   │                                                            └── tab screenshot
   ├── Desktop channel ── UI Automation + process management (PowerShell-backed)
   ├── Screen capture ── full-screen / window screenshot
   └── Code fallback ─── generated PowerShell/JS (strictest gate)

Pilot service (C3c) ── background runAgentLoop with the control tools
   ├── task store (C2 engine primitive)
   └── delivery queue (C2 engine primitive) → voice/text announcements
```

New modules:

- `src/control/types.ts` — intents, effect levels, trust levels, bridge
  protocol types, journal entry type.
- `src/control/policy.ts` — effect-level classification and trust-level
  decisions: `allowed | needs_grant | needs_confirmation | rejected` with a
  reason the model can relay.
- `src/control/executor.ts` — routes typed intents to channels; owns the
  channel-availability logic (e.g. browser intents fail fast with guidance
  when no extension is connected).
- `src/control/browserBridge.ts` — WebSocket server, pairing, request/response
  correlation, timeouts.
- `src/control/screenCapture.ts` — full-screen/window capture, downscaling.
- `src/control/desktop.ts` (C3c) — UIA queries/invocation, process focus/close.
- `src/control/pilot.ts` (C3c) — pilot lifecycle on taskStore/deliveryQueue.
- `src/control/journal.ts` — append-only per-session action journal under the
  C2 state root (`~/.llmtest/state/control/`).
- `extension/` (repo root) — the Chrome MV3 extension (§7.1).
- `src/providers/tools/` — `screenView.ts`, `browserRead.ts`, `browserAct.ts`,
  `desktopAct.ts`, `controlCode.ts`, `pilotTask.ts`, `pilotStatus.ts`,
  `pilotCancel.ts`.

As in C2, the model only ever supplies intent-level fields; executable paths,
ports, tokens, PowerShell templates, and protocol details are owned by trusted
application code.

## 6. Slice C3a — Screen vision

### 6.1 Image content parts in the provider layer

`Message.content` (src/types.ts) becomes `string | ContentPart[]` where:

```ts
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: "image/png" | "image/jpeg"; base64: string };
```

- Every provider and call site that assumes `string` is updated to a shared
  helper (`messageText(msg)`) so text-only paths keep working unchanged.
- `ILLMProvider` gains `supportsImages?: boolean`. The Google provider maps
  image parts to `inlineData`; GitHub and Ollama declare `false` in this
  slice (Ollama gains it later with a vision model — do not build now).
- The agent loop learns one new rule: when a tool result is an object
  `{ kind: "image", mimeType, base64, note? }`, it is appended as an image
  content part (plus the `note` text) instead of being JSON-stringified.

### 6.2 Screen capture

- `screenCapture.ts` shells a PowerShell snippet (System.Drawing
  `CopyFromScreen`, or `PrintWindow` for a single window by title match) —
  no new native npm dependency.
- With several monitors, `target: "screen"` captures Windows' complete
  `VirtualScreen` rectangle as one combined image. This includes displays
  positioned at negative desktop coordinates. `target: "window"` captures
  the selected window independently of the monitor on which it is displayed.
- Output PNG is downscaled to a max long edge (default 1568 px) before
  base64-encoding, to bound token cost.
- Captures are written to the task/session artifact area only when journaling
  requires it (config, default: keep the last 5 per session), never persisted
  indefinitely.

### 6.3 `screen_view` tool

```jsonc
{
  "target": "screen",        // "screen" | "window" | "browser_tab" (C3b+)
  "window_title": "…",       // required when target = "window"
  "question": "…"            // optional: what to look for
}
```

Behavior:

- If the **active conversation provider** supports images, the tool returns
  the image object (§6.1) so the main model sees the screen directly.
- Otherwise it makes one side call to the configured **vision provider**
  (`CONTROL_VISION_PROVIDER`, default `google`) asking it to describe the
  capture — guided by `question` — and returns the text description. This
  keeps local text-only models usable.
- Effect level: observe (§8.1). Always allowed, always journaled.
- Privacy: a capture sent to a cloud vision provider leaves the machine. This
  is stated once in the tool description and accepted implicitly by the user
  asking Voxara to look; `CONTROL_VISION_PROVIDER=ollama` will later make it
  fully local.

**Future enhancement — individual monitor selection:** extend `screen_view`
with `target: "monitor"` and a stable monitor selector (index and/or display
name). This would capture only the requested display, improving text clarity
after downscaling and preventing unrelated content on other monitors from
being included. Monitor enumeration and selection are deferred; the current
`target: "screen"` behavior remains the full combined virtual desktop.

**C3a acceptance:** in a live voice session with the Google provider,
"regarde mon écran et dis-moi ce que tu vois" produces a correct spoken
description; with provider=ollama the describe-fallback path works; all C2
tests still pass.

Implementation note (2026-07-12): C3a was live-validated with the Google
provider. It persists the last five requested captures per session beside its
JSONL journal so the observation is auditable; older capture artifacts are
removed on each capture. CI continues to use fake captures and providers.

## 7. Slice C3b — Browser control

### 7.1 Chrome extension (`extension/`)

MV3, minimal permissions (`tabs`, `activeTab`, `scripting`, `storage`). Parts:

- **Service worker:** maintains one WebSocket to
  `ws://127.0.0.1:<CONTROL_BRIDGE_PORT>` (default 7863; 7861/7862 are TTS/STT).
  Reconnects with backoff. First frame is
  `{ type: "hello", token, extensionVersion }`.
- **Pairing:** Voxara generates a token on first run, stores it under the
  state root, and shows it via `llmtest control doctor`; the user pastes it
  once into the extension's options page. The bridge closes any connection
  whose hello token mismatches. The server binds to 127.0.0.1 only.
- **Content script (injected on demand via `scripting`):** builds snapshots
  and executes element actions in the page.

### 7.2 Bridge protocol

JSON request/response with correlation ids, one in-flight map, per-request
timeout (default 10 s). Commands the extension serves:

- `snapshot` → `{ url, title, elements: [{ ref, role, name, value?, state? }] }`
  — a compact accessibility-style outline of the **active tab** (or a given
  tab id). Interactive elements get ephemeral refs (content-script WeakMap;
  refs are invalidated by navigation or the next snapshot). Output is bounded
  (`CONTROL_MAX_SNAPSHOT_CHARS`, default 8000), viewport-visible elements
  first, then a truncation marker.
- `act` → `{ ref, action: "click" | "fill" | "select" | "scroll_to", value? }`
  with the element's post-action state in the response.
- `navigate` → `{ url }` (active tab), `tabs` →
  `{ op: "list" | "activate" | "open" | "close", … }`.
- `screenshot` → `chrome.tabs.captureVisibleTab` as base64 PNG (serves
  `screen_view` with `target: "browser_tab"` — sharper and cheaper than a
  full-screen capture).

### 7.3 Tools

- **`browser_read`** `{ what: "page" | "tabs", tab_id? }` — snapshot or tab
  list. Effect level: observe.
- **`browser_act`**
  `{ action: "click"|"fill"|"select"|"navigate"|"open_tab"|"activate_tab"|"close_tab"|"scroll_to", ref?, value?, url?, tab_id? }`
  — one intent per call. The tool description instructs the model to
  `browser_read` first and use fresh refs.

When no extension is connected, both fail fast with a user-relayable message
("l'extension Chrome n'est pas connectée — `llmtest control doctor` explique
l'appairage").

**C3b acceptance:** live session — "ouvre YouTube" (navigate/open_tab),
"clique sur la première vidéo" (read → act by ref), "ferme cet onglet"
(sensitive → confirmation under `session_grant`), each working by voice in
the user's real Chrome window.

## 8. Control policy

### 8.1 Effect levels

The policy classifies every intent — by its **effect**, never by target
content (D1):

| Level | Meaning | Examples |
|---|---|---|
| `observe` | reads only | `screen_view`, `browser_read`, desktop queries |
| `act_reversible` | undoable by an equal opposite action | click (non-submitting), fill/select, scroll, navigate, open/activate tab, open/focus app |
| `act_sensitive` | destructive, committing, or unbounded | form **submission** (submit-type click, Enter-in-form), close tab/app, delete, keyboard chords (Ctrl+W…), anything via `control_code` |

Classification heuristics live in `policy.ts` (e.g. a click on
`role=button` + `type=submit` or inside a `form` is a submission). **Unknown
or unclassifiable ⇒ escalate to `act_sensitive`.** The browser snapshot
carries the state bits the classifier needs (element roles/types); the
desktop channel flags close-with-unsaved-state when UIA exposes it.

### 8.2 Trust levels

`CONTROL_TRUST_LEVEL` = `confirm_each` | `session_grant` (default) | `auto`:

| | observe | act_reversible | act_sensitive |
|---|---|---|---|
| `confirm_each` | free | confirm each | confirm each |
| `session_grant` | free | free once the session grant is given (§4.1) | confirm each |
| `auto` | free | free | free |

- The policy returns `allowed | needs_grant | needs_confirmation | rejected`
  plus a reason; the **tools** relay `needs_*` outcomes to the conversational
  agent, which asks the user with the concrete effect and retries the same
  call with `confirmed: true` after an explicit yes (same conversational
  contract as C2's approval flow; no persistent pending state is needed for
  fast-lane intents — pilots use the delivery queue for approvals).
- `auto` skips confirmations but **never** skips journaling, the kill-switch,
  or user-input pause. `control_code` remains confirmed even under `auto`
  unless `CONTROL_CODE_AUTO=true` is set explicitly.

### 8.3 Journal

Append-only JSONL per session under `~/.llmtest/state/control/`: timestamp,
lane, intent, target summary, policy decision, outcome, error. Bounded
retention (config, default 30 days), pruned like C2 artifacts.

## 9. Slice C3c — Desktop, code fallback, and the pilot

### 9.1 `desktop_act`

`{ action: "open_app" | "focus" | "close" | "list_windows" | "invoke", target?, element? }`

- `open_app`/`focus`/`close`: process + window management via PowerShell
  (`Start-Process`, window activation, graceful `CloseMainWindow` before
  `Stop-Process`). `close` is `act_sensitive`.
- `list_windows`/`invoke`: **UI Automation** (System.Windows.Automation via
  PowerShell) — enumerate a window's elements by name/role, invoke one
  programmatically. This is the desktop analogue of the browser snapshot/act
  pair; `screen_view` provides visual verification when UIA names are
  ambiguous.
- Pixel-coordinate input synthesis is **not** implemented (non-goal); if a
  target has no UIA surface, the answer is `control_code` or "je ne peux pas
  piloter cette application proprement".

### 9.2 `control_code`

`{ language: "powershell" | "browser_js", code, rationale }` — the D2
fallback. Always `act_sensitive`; the confirmation shown to the user includes
`rationale` and a plain-language summary of what the code does (produced by
the model in `rationale`, displayed verbatim). `browser_js` executes in the
page via the extension; `powershell` via the supervised process runner
(`src/delegation/processRunner.ts` — reuse, no shell interpolation, output
bounded). Journaled with the full code text.

### 9.3 Pilot service

- `pilot_task` `{ goal, context?, budget_steps? }` dispatches an internal
  **`runAgentLoop`** (src/engine/agentLoop.ts) in the background with exactly
  the control tools (fast-lane set, minus `pilot_*`), the configured
  provider, and a step budget (default 20). No child process — the pilot is
  in-process, like a delegation but running our own loop instead of a coding
  agent.
- Task records live in the C2 **task store** with a new task kind (`pilot`);
  results, failures, grant/confirmation requests, and pause notices flow
  through the **delivery queue** with the same turn-boundary voice
  announcement mechanics validated in C2a.
- Policy inside the pilot is identical (§8); a `needs_confirmation` outcome
  suspends the pilot and queues a `task_approval`-style delivery; the user's
  yes resumes it (`pilot_approve` mirrors `delegate_approve` — or the C2
  approval tool is generalized if trivially possible; implementer's choice,
  documented in this file when made).
- **User-input pause** (§4.3) is checked before each acting step via
  `GetLastInputInfo`. **`pilot_cancel`** aborts between steps and interrupts
  the in-flight bridge/UIA call.
- One pilot at a time (concurrency 1, dispatch rejects like C2's limit
  behavior); a pilot and the fast lane never run concurrently — while a
  pilot is `running`, fast-lane acting tools return "pilot en cours" with the
  task id.

**C3c acceptance:** live — "ferme toutes les fenêtres sauf Chrome" runs as a
pilot with one confirmation listing the apps to close; moving the mouse
mid-run pauses it with a spoken hand-back; "compare ce produit sur deux
autres sites" browses in background and speaks a summary at an idle boundary.

## 10. Configuration (env, C2 naming style)

| Variable | Default | Meaning |
|---|---|---|
| `CONTROL_TRUST_LEVEL` | `session_grant` | §8.2 |
| `CONTROL_VISION_PROVIDER` | `google` | provider for the describe-fallback |
| `CONTROL_BRIDGE_PORT` | `7863` | extension WebSocket port (localhost) |
| `CONTROL_MAX_SNAPSHOT_CHARS` | `8000` | snapshot truncation budget |
| `CONTROL_SCREENSHOT_MAX_EDGE` | `1568` | capture downscale bound (px) |
| `CONTROL_PILOT_MAX_STEPS` | `20` | pilot step budget |
| `CONTROL_CODE_AUTO` | `false` | let `auto` skip `control_code` confirmation |
| `CONTROL_JOURNAL_RETENTION_DAYS` | `30` | journal pruning |

## 11. Test plan

Fake-first, like C2 §15 — no live Chrome, GPU, or provider in CI:

- **Provider images:** unit tests that Google request payloads carry
  `inlineData` parts; that text-only providers reject/degrade cleanly; that
  the agent loop turns an image tool result into an image content part.
- **Bridge:** a fake extension (test WebSocket client) exercising pairing
  (bad token rejected), snapshot bounding, act round-trips, timeouts, and
  disconnect fail-fast messages.
- **Policy:** classification table cases including the submit-click and
  unknown⇒sensitive rules; the trust-level matrix; `confirmed: true` retry.
- **Executor/desktop:** PowerShell templates validated with a fake runner
  (reusing the C2 fake-executable pattern); no shell interpolation.
- **Pilot:** fake control tools driving grant-suspend-resume, user-input
  pause (injected input timestamp), cancel mid-run, step budget exhaustion,
  startup recovery of an interrupted pilot.
- **Live validation** (per slice, by the user — one verification pass, no GPU
  benchmark loops): the acceptance scenarios in §6.3/§7.3/§9.3.

## 12. Sequencing

```
C3a vision (provider images + screen_view) ── standalone value, smallest risk
C3b browser (extension + bridge + read/act + policy/journal/grant)
C3c pilot + desktop (pilot service, desktop_act, control_code, pauses)
```

Each slice is designed, implemented, live-tested, and its deviations recorded
in this document before the next begins — the C2 working rhythm.
