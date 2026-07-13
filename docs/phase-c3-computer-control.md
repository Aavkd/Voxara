# Phase C3: Computer Control — Screen Vision and Interactive Control

> **Status: Slice C3a implemented and live-validated 2026-07-12.
> Slice C3b implemented 2026-07-13 (extension + bridge + browser_read /
> browser_act + policy/journal/grant + `llmtest control doctor`) — live
> validation pending. Slice C3c fully conceptualized 2026-07-13 (decisions
> D8–D11) and split into C3c1 (desktop control + code fallback) and C3c2
> (pilot); both remain to implement. Priority (decision
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

Added 2026-07-13 (C3c conceptualization with the user):

- **D8 — Desktop mirrors the browser pair.** The desktop surface is
  `desktop_read` (observe) + `desktop_act` (act), replacing the earlier
  single-tool sketch that folded `list_windows`/`invoke` into `desktop_act`.
  Same read-before-act contract the model already knows from C3b, same
  ephemeral refs, same snapshot character budget, same executor-side ref
  cache feeding the policy classifier.
- **D9 — Keyboard input takes two routes.** *Executing a command visibly*
  ("ouvre un terminal et lance X") is expressed as `open_app` with `args` —
  the terminal is launched with the command, no focus race. *Interacting
  with an already-open app* uses `type` (literal text to a focused window)
  and `keys` (named keys/chords). `type` rejects control characters, so
  pressing Enter is always an explicit `keys` intent — which is exactly what
  the policy gates.
- **D10 — Command execution is act_sensitive.** `keys` (Enter, chords) and
  `open_app` whose args are not existing filesystem paths are the desktop
  analogue of the form submit (§8.1): individually confirmed under
  `session_grant`, with the concrete effect named ("je lance `npm test`
  dans le terminal — je confirme ?"). Typing the text itself stays
  reversible; it is pressing Enter that commits.
- **D11 — C3c ships as two sub-slices.** C3c1 = desktop control + the
  `control_code` fallback, live-validated on the terminal / Explorer /
  VS Code scenarios (§9.5). C3c2 = the pilot service. Refines D7's slice
  order; each sub-slice is live-tested before the next.

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
   │ fast lane: screen_view / browser_read / browser_act / desktop_read / desktop_act / control_code
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
   ├── Desktop host ──── persistent PowerShell helper (stdio JSON lines)
   │                       ├── UI Automation (read outline / invoke / set_value)
   │                       ├── keyboard input (type / keys, focus-verified)
   │                       └── process & window management (open/focus/close)
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
- `src/control/desktopHost.ts` (C3c1) — persistent PowerShell helper process:
  spawn/restart, request/response correlation over stdio JSON lines (§9.3).
- `src/control/desktop.ts` (C3c1) — desktop executor over the host: window
  outline + ref cache, app resolution, focus-verified input, policy hookup.
- `src/control/pilot.ts` (C3c2) — pilot lifecycle on taskStore/deliveryQueue.
- `src/control/journal.ts` — append-only per-session action journal under the
  C2 state root (`~/.llmtest/state/control/`).
- `extension/` (repo root) — the Chrome MV3 extension (§7.1).
- `src/providers/tools/` — `screenView.ts`, `browserRead.ts`, `browserAct.ts`,
  `desktopRead.ts`, `desktopAct.ts`, `controlCode.ts`, `pilotTask.ts`,
  `pilotStatus.ts`, `pilotCancel.ts`.

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

### 7.4 Implementation notes (2026-07-13)

Deviations from the design above, forced by MV3/Chrome constraints:

- **Permissions:** in addition to `tabs`/`activeTab`/`scripting`/`storage`,
  the manifest needs `host_permissions` (`http://*/*`, `https://*/*`) so
  `chrome.scripting.executeScript` and `captureVisibleTab` work on arbitrary
  pages without a user gesture, and the `alarms` permission for a 1-minute
  reconnect alarm — an MV3 service worker's `setTimeout` does not survive
  suspension. An app-level ping/pong every 20 s over the WebSocket keeps the
  worker alive between alarms.
- **No separate content-script file:** snapshot/act run as self-contained
  functions injected on demand via `chrome.scripting.executeScript`. They run
  in the extension's isolated world, which persists per document, so the
  ref registry (`window.__voxaraRefs`, a plain Map) survives between calls
  and dies naturally on navigation — same lifecycle the WeakMap design aimed
  for.
- **Options page** stores the port as well as the token (both under
  `chrome.storage.local`), for non-default `CONTROL_BRIDGE_PORT` setups.
- **Snapshot bounding is app-side:** the extension caps at 200 elements,
  viewport-visible first; `src/control/executor.ts` then applies the
  `CONTROL_MAX_SNAPSHOT_CHARS` character budget and appends the truncation
  marker. The executor also caches the last snapshot's elements so
  `policy.ts` can classify a click by its ref's state bits — an unknown ref
  classifies as `act_sensitive` (§8.1).
- **Bridge start:** `voice-chat --agent` and `agent-chat` start the bridge
  eagerly when browser tools are active (the extension connects out to the
  long-lived process); `llmtest control doctor` prints the pairing token and
  performs a ~6 s live connection check. When a session already owns the
  port, doctor reports that as the normal live setup.

### 7.5 Live findings (first C3b voice test, 2026-07-13) and fixes

The extension, pairing, snapshot/act and the grant flow all worked live, but
the session degraded over time: the model increasingly emitted
`[tool_call: …]` as TEXT, which the TTS read aloud. Root cause: the agent
loop replayed past tool exchanges into the history as that exact text
format, so the model learned to imitate it instead of calling the API —
and each leaked answer was saved into the session, reinforcing the pattern
every turn. Fixes, all shipped 2026-07-13:

1. Tool exchanges are now STRUCTURED history (`tool_call`/`tool_result`
   content parts, src/types.ts) mapped to Gemini's native
   `functionCall`/`functionResponse` parts (SDK role `function` for
   responses). Gemini 3 additionally requires the part-level
   `thoughtSignature` to be echoed back with every replayed functionCall
   (400 otherwise, verified live); calls the model did not produce use the
   documented `skip_thought_signature_validator` placeholder.
2. Loop guardrail: a "final answer" matching the textual tool-call pattern
   is parsed and executed instead of returned.
3. The voice pipeline strips any leaked tool syntax before TTS and before
   saving the turn into the session (stops the contamination loop).
4. All parallel function calls of one Gemini response are executed in order
   (only the first was kept before — the reason the model fell back to text
   for fill+click sequences).
5. `browser_act` rejects invented refs (XPaths, selectors, bare numbers)
   with guidance, and the snapshot names image-only links/buttons from
   descendant `aria-label`/`img alt`/svg titles or a readable href tail.

Live re-validation of the §7.3 acceptance scenarios is still pending after
these fixes.

## 8. Control policy

### 8.1 Effect levels

The policy classifies every intent — by its **effect**, never by target
content (D1):

| Level | Meaning | Examples |
|---|---|---|
| `observe` | reads only | `screen_view`, `browser_read`, `desktop_read` (windows, UIA outline) |
| `act_reversible` | undoable by an equal opposite action | click (non-submitting), fill/select, scroll, navigate, open/activate tab, open/focus app (no args, or args that are existing file/dir paths), UIA `invoke`/`set_value`, `type` literal text |
| `act_sensitive` | destructive, committing, or unbounded | form **submission** (submit-type click, Enter-in-form), `keys` (Enter, chords like Ctrl+W), `open_app` with non-path args (command execution, D10), close tab/app, delete, anything via `control_code` |

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

Ships as two sub-slices (D11): **C3c1** = §9.1–§9.5 (desktop_read /
desktop_act, the desktop host, control_code), live-validated on the §9.5
scenarios; then **C3c2** = §9.6 (the pilot service).

### 9.1 `desktop_read` (observe)

```jsonc
{
  "what": "windows",         // "windows" | "elements"
  "target": "…"              // required when what = "elements": window title substring
}
```

- `windows` → top-level windows: `{ title, process, pid, focused }`. This is
  how the model discovers what is open and disambiguates titles.
- `elements` → **UI Automation outline** of one window, matched by title
  substring (case- and diacritic-insensitive): interesting elements only
  (invokable, editable, selectable, expandable, plus structural
  headers/text), each with an ephemeral `ref`, control type, name, and state
  bits (enabled, focused, toggle/checked, value when cheap). Bounded by
  `CONTROL_MAX_SNAPSHOT_CHARS` exactly like the browser snapshot; refs are
  invalidated by the next `elements` read, a desktop-host restart, or the
  window closing. An ambiguous `target` (several matching windows) returns
  the candidate titles instead of guessing — the model refines or asks.
- The executor caches the last outline's elements so `policy.ts` classifies
  `invoke`/`set_value` by ref, mirroring the browser path (§7.4); an unknown
  ref classifies as `act_sensitive` (§8.1 rule).

### 9.2 `desktop_act`

One intent per call:

```jsonc
{
  "action": "open_app" | "focus" | "close" | "invoke" | "set_value" | "type" | "keys",
  "target": "…",   // open_app: app name; focus/close/type/keys: window title substring
  "args": ["…"],   // open_app only: launch arguments
  "ref": "…",      // invoke / set_value: element ref from the last desktop_read
  "value": "…",    // set_value
  "text": "…",     // type: literal text, control characters rejected
  "keys": "…"      // keys: named key/chord, e.g. "enter", "ctrl+s", "alt+f4"
}
```

| action | effect level |
|---|---|
| `open_app` | reversible without `args`, or when **every** arg is an existing file/dir path (opening a document); otherwise **sensitive** (command execution, D10) |
| `focus` | reversible |
| `close` | **sensitive** — graceful `CloseMainWindow` first; the confirmation names the window and flags unsaved state when UIA exposes it |
| `invoke` | reversible; unknown/stale ref ⇒ sensitive |
| `set_value` | reversible (UIA ValuePattern — the desktop `fill`) |
| `type` | reversible — literal text only; text containing control characters is rejected with guidance to use `keys` |
| `keys` | **sensitive** (D10) — Enter and chords commit, close, or trigger arbitrary shortcuts |

- **App resolution is trusted code** — the model supplies a friendly name
  (`"vs code"`, `"terminal"`, `"explorateur"`), never an executable path.
  Resolution order: Start Menu shortcuts (user + all-users `.lnk`), the
  App Paths registry (HKCU/HKLM), PATH lookup (`where.exe`), then
  `Get-StartApps` for UWP apps. Several plausible candidates ⇒ the tool
  returns them and the model asks the user. File/dir args are validated and
  passed as discrete arguments (no shell interpolation).
- **Focus safety for `type`/`keys`:** the executor focuses `target`,
  verifies it is the foreground window, sends the input
  (SendInput/SendKeys with trusted-code escaping of metacharacters), and
  re-verifies; a focus change mid-send aborts with a relayable error rather
  than typing into the wrong window.
- **The two keyboard routes in practice (D9):** "ouvre un terminal et lance
  `npm test`" is `open_app { target: "terminal", args: [… npm test …] }` —
  one sensitive intent, one confirmation naming the command. "Tape
  `git status` dans le terminal et exécute" is `type` (free under the
  session grant) followed by `keys "enter"` (confirmed with the command it
  executes). The tool description steers the model: to *run* something,
  prefer launch-with-args; `type` is for interacting with an app that is
  already open.
- Pixel-coordinate input synthesis remains **not** implemented (non-goal);
  if a target has no usable UIA surface, the answer is `control_code` or
  "je ne peux pas piloter cette application proprement". Known limitation to
  verify live: Electron/Chromium apps (VS Code) build their UIA tree only
  once an accessibility client queries them, and its quality varies.
- Journaling: like every intent (§8.3), with the target summary; `type`
  text and `open_app` args are journaled in full, like `control_code` code.

### 9.3 Desktop host

UIA element refs must stay alive between a `desktop_read` and the following
`desktop_act`, and a fresh `powershell.exe` per call costs about a second.
`src/control/desktopHost.ts` therefore owns **one persistent PowerShell
helper per session** — the desktop twin of the browser bridge:

- Spawned on first desktop intent (`-NoProfile`, resident script), speaking
  request/response **JSON lines over stdio** with correlation ids and
  per-request timeouts, mirroring the bridge protocol discipline (§7.2).
- The helper owns the UIA work (System.Windows.Automation), the ref registry
  (live `AutomationElement` cache keyed by ref — the reason it must be a
  persistent process), keyboard input, and process/window management.
- Crash/exit ⇒ automatic restart on next intent; all refs are declared stale
  (unknown ref ⇒ sensitive, so a stale-ref act degrades safely into a
  confirmation, never a wrong-target action).
- C2 runner rules apply: no shell interpolation anywhere, bounded output,
  the helper script is a static asset owned by the application — the model
  never contributes to it.

### 9.4 `control_code`

`{ language: "powershell" | "browser_js", code, rationale }` — the D2
fallback. Always `act_sensitive`; the confirmation shown to the user includes
`rationale` and a plain-language summary of what the code does (produced by
the model in `rationale`, displayed verbatim). `browser_js` executes in the
page via the extension; `powershell` via the supervised process runner
(`src/delegation/processRunner.ts` — reuse, no shell interpolation, output
bounded). Journaled with the full code text.

### 9.5 C3c1 acceptance

Live, by voice, in one session:

- "Ouvre l'explorateur de fichiers" then "ouvre VS Code" — `open_app`, free
  once the session grant is given.
- "Ouvre un terminal et lance `npm test`" — `open_app` with args → exactly
  one confirmation naming the command, then the terminal appears running it.
- "Tape `git status` dans le terminal et exécute" — `type` free under the
  grant, `keys enter` confirmed with the concrete command.
- One in-app UIA interaction, e.g. `desktop_read elements` on Notepad and
  `invoke` on a menu item.
- The Electron caveat checked on VS Code: outline quality recorded here; if
  unusable, the documented answer is `screen_view` + `control_code`.
- All C2/C3 tests still pass.

### 9.6 Slice C3c2 — pilot service

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

**C3c2 acceptance:** live — "ferme toutes les fenêtres sauf Chrome" runs as a
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
  unknown⇒sensitive rules; the trust-level matrix; `confirmed: true` retry;
  the D9/D10 desktop cases (open_app args path-vs-command, type control-char
  rejection, keys sensitive, stale desktop ref ⇒ sensitive).
- **Executor/desktop:** a fake desktop host (test stdio process, like the
  fake extension) exercising app-resolution ambiguity, ref lifecycle across
  host restart, focus-verification abort, outline bounding, timeouts;
  PowerShell templates validated with a fake runner (reusing the C2
  fake-executable pattern); no shell interpolation.
- **Pilot:** fake control tools driving grant-suspend-resume, user-input
  pause (injected input timestamp), cancel mid-run, step budget exhaustion,
  startup recovery of an interrupted pilot.
- **Live validation** (per slice, by the user — one verification pass, no GPU
  benchmark loops): the acceptance scenarios in §6.3/§7.3/§9.3.

## 12. Sequencing

```
C3a vision (provider images + screen_view) ── standalone value, smallest risk
C3b browser (extension + bridge + read/act + policy/journal/grant)
C3c1 desktop (desktop host + desktop_read/desktop_act + control_code)
C3c2 pilot (pilot service, pauses, delivery-queue approvals)
```

Each slice is designed, implemented, live-tested, and its deviations recorded
in this document before the next begins — the C2 working rhythm.
