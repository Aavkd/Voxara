# Terminal Control Robustness Specification

> **Status: agreed design - source of truth for implementation.**
> Created on 2026-07-14 after the live PowerShell incident audit requested by
> Alexy. Coding agents implementing terminal execution or desktop text input
> MUST follow this document. If an implementation constraint requires a
> deviation, update this document in the same change and explain the deviation.
>
> **Precedence:** this specification supersedes the terminal-command and
> keyboard-text portions of
> [`phase-c3-computer-control.md`](phase-c3-computer-control.md), especially the
> guidance in sections 9.2, 9.3, 9.5, and the live findings that recommend
> `desktop_act type submit=true` as the normal command-execution path. It does
> not supersede the browser, UI Automation, screen vision, pilot, journal, or
> general control-lane architecture except where this document says so.

## 1. Why this document exists

Voxara must be able to perform terminal work requested by the user, from a
simple system inspection to multi-step development and administration tasks.
The implementation live-tested on 2026-07-14 cannot provide that guarantee.

The immediate incident looked like a sequence of PowerShell syntax errors, but
the audit established that most commands were valid before transport and were
corrupted while being typed into Windows Terminal. The current tool then
reported success without observing the command result, causing Voxara to make
false success claims and retry the wrong layer.

This specification defines the robust replacement. Its central rule is:

> **Executing a shell command is a process-control operation, not a simulated
> keyboard operation.**

Desktop typing remains useful for interacting with ordinary GUI applications,
but it is not the source of truth for terminal execution.

The terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 2. Incident record and evidence

### 2.1 Live session

- Date: 2026-07-14
- Voice session id: `0e40b4f4-f55a-4d73-8c72-da6db8e5a489`
- User goal: display RAM and CPU information in PowerShell.
- Initial canary: `echo "Test de communication réussi"` appeared to work.
- Complex commands then failed repeatedly.

The canary was misleading because it did not contain the punctuation most
affected by the input transport.

### 2.2 Requested text versus received text

The tool-call history contains the exact text requested by the model. The
terminal log contains the text that PowerShell actually parsed. Comparing them
shows deterministic corruption:

| Requested fragment | Fragment received by PowerShell | Effect |
| --- | --- | --- |
| `Get-Process \| Measure-Object` | `Get-Process  Measure-Object` | Pipeline removed |
| `@{Name=...;Expression={...}}` | `@Name=...;Expression=...}}` | Opening braces removed |
| `[math]::Round(...)` | `math]::Round(...)` | Opening bracket removed |
| `\Memory\Available MBytes` | `MemoryAvailable MBytes` | Counter path corrupted |
| `\% Processor Time` | `5 Processor Time` | Backslash removed and `%` changed to `5` |
| `systeminfo \| findstr ...` | `systeminfo  findstr ...` | `findstr` became an invalid `systeminfo` argument |

The `@` character itself survived. PowerShell did not reject hash tables or
calculated properties. The earlier report blaming `@{}` or direct terminal
entry is therefore not an accurate root-cause analysis.

### 2.3 Parser audit

Six representative model-generated commands were passed to the native
PowerShell parser without executing them:

- Five parsed with zero syntax errors.
- One contained a genuine model typo: `$/...` instead of `$_.…`.

This distinction matters. Voxara can still generate a bad command, so syntax
validation is valuable, but model quality was not the main cause of this
incident.

### 2.4 Confirmed root cause

`src/control/desktopHost.ts` uses
`System.Windows.Forms.SendKeys.SendWait` after escaping SendKeys metacharacters.
The active foreground keyboard layout during the audit was French `040C`; both
French `040C` and US English `0409` layouts were installed.

`SendKeys` is layout-sensitive and Microsoft explicitly warns that it can
produce unpredictable results across international keyboard layouts. The
observed missing and transformed characters are consistent with that failure
mode.

### 2.5 Contributing failures

The keyboard-layout defect became a user-visible reliability loop because of
four additional design problems:

1. `typed` is computed from the requested string length, not from text received
   by the target application.
2. `submitted: true` only means Enter was sent; it does not mean the command
   parsed, ran, or succeeded.
3. The control journal records the desktop action as `success` after input
   delivery, without stdout, stderr, or exit status.
4. The `desktop_act` description steers the model to type and submit terminal
   commands, while the supervised PowerShell runner is described as a gated
   fallback.

## 3. Product goals

The terminal-control system MUST:

1. Execute non-interactive PowerShell commands without keyboard-layout
   dependence.
2. Return structured stdout, stderr, exit status, timeout state, and truncation
   state to the agent.
3. Support an explicit working directory.
4. Support persistent, stateful, and interactive terminal work when needed.
5. Preserve accents, punctuation, and Unicode exactly.
6. Distinguish validation, transport, process, command, timeout, cancellation,
   and target-window failures.
7. Never claim command success from input delivery alone.
8. Avoid duplicate execution during approval retries or model retries.
9. Keep output bounded and kill the complete process tree on timeout or cancel.
10. Preserve the existing control journal and user approval model while making
    shell authorization more conservative, not less.
11. Remain usable from both text and real-time voice conversations.
12. Provide tests that reproduce the original French-layout failure and prove
    it fixed.

## 4. Non-goals for the first robust release

- Durable shell sessions that survive a Voxara process restart.
- A cross-platform PTY abstraction. The first release targets Windows and
  PowerShell; the API must remain extensible to `cmd`, WSL, and other shells.
- Automatic privilege elevation or bypassing UAC.
- Guaranteeing automation of an elevated target from a non-elevated Voxara
  process.
- Replacing all desktop UI Automation with keyboard injection.
- Treating screenshots or OCR as authoritative terminal output.
- Inferring that arbitrary generated code is safe solely from a model-provided
  label.
- A perfect static classifier for every possible PowerShell side effect. When
  trusted code cannot prove a lower risk, policy must escalate conservatively.

## 5. Normative design decisions

### T1 - Separate execution from presentation

The system MUST have a direct shell-execution channel. Opening a visible
terminal window is a presentation choice and MUST NOT be required to obtain a
correct process result.

### T2 - Use one-shot execution for ordinary commands

Simple inspections and bounded tasks use `shell_exec`. Each call starts a
supervised process, runs one script in an explicit working directory, captures
its result, and exits.

### T3 - Use a managed terminal session for stateful work

Tasks that need persistent `cwd`, environment, shell history, a development
server, REPL, prompt interaction, or incremental output use `shell_session`.
On Windows, its implementation SHOULD use ConPTY or a maintained Node binding
over ConPTY rather than GUI keystrokes.

### T4 - Desktop text injection must be Unicode-based

`desktop_act type` remains available for literal GUI text. Its default Windows
implementation MUST use native `SendInput` with `KEYEVENTF_UNICODE` for text
characters. Named keys and chords MAY use virtual-key or scan-code events.

`System.Windows.Forms.SendKeys` MUST NOT remain the primary literal-text path.

### T5 - Process results are structured

The shell channel returns an object, not a formatted prose blob. Tool code,
policy code, tests, journals, and the agent must be able to distinguish all
terminal states without parsing human-readable text.

### T6 - Success means successful completion

For `shell_exec`, `status="completed"` requires all of the following:

- the process started;
- syntax validation passed when available;
- the process did not time out or get cancelled;
- the shell exited;
- exit code is `0`.

A non-zero exit is `status="failed"`. Input delivery is never called command
success.

### T7 - The workspace is the default working directory

The tool's default `cwd` is the sandbox/workspace directory passed to the tool
provider, not `os.tmpdir()`. A caller may supply another authorized directory.
The resolved canonical directory is returned in the result.

### T8 - Validate before executing

PowerShell scripts SHOULD be parsed using
`System.Management.Automation.Language.Parser.ParseInput` before execution.
Parser errors are returned with line, column, error id, and message. Parsing
must not execute the script.

Preflight validation catches malformed generated commands but is not a safety
sandbox and must not be represented as one.

### T9 - At-most-once execution per approved call

Every shell execution has a runtime-generated `commandId`. Approval replay must
resume the exact stored call with the same id. The runtime MUST reject a second
execution of an already terminal `commandId` unless the user makes a new
request or explicitly asks to retry.

### T10 - Conservative authorization

The model supplies a rationale and an expected effect for user communication,
but those fields are not the security boundary. Trusted policy may upgrade the
risk level and must never silently downgrade it.

If trusted policy cannot establish that a script is observational, it is
sensitive. Destructive or materially mutating shell actions require a concrete
per-action confirmation. A broad session grant MUST NOT silently authorize
unknown raw code.

### T11 - Explicit uncertainty and retry limits

The agent must not say that a command worked without a completed structured
result. After two failures with the same failure class, it must stop producing
syntax variants, summarize the observed failure, and switch channel or ask for
help. Transport errors must not be treated as shell-syntax errors.

## 6. Target architecture

```text
Conversational or pilot agent
            |
            +-- shell_exec -------------------+
            |                                  |
            +-- shell_session ----------------+--> shell service
            |                                  |      |
            |                                  |      +-- PowerShell parser
            |                                  |      +-- supervised process / ConPTY
            |                                  |      +-- stdout/stderr/exit/cancel
            |                                  |
            +-- desktop_act ------------------+--> desktop host
                                                   +-- UI Automation
                                                   +-- Unicode SendInput
                                                   +-- focus verification

All acting paths --> control policy --> correlated journal events
```

The shell service and desktop host may share lifecycle utilities, policy types,
and journal infrastructure. They do not share a text-delivery implementation.

## 7. `shell_exec` contract

### 7.1 Purpose

Run one bounded, non-interactive shell script and return its complete structured
outcome. This is the default tool for requests such as:

- inspect system information;
- list files or processes;
- run a build or test command expected to terminate;
- transform a bounded set of files when the user requested the change;
- invoke Git, npm, or another CLI and capture its result.

### 7.2 Input schema

```jsonc
{
  "script": "Get-Date",
  "shell": "powershell",
  "cwd": "D:\\Documents\\MANTARA\\AI COMPAGNON APP",
  "timeout_ms": 30000,
  "expected_effect": "observe",
  "rationale": "Read the current system date without changing files."
}
```

Fields:

| Field | Required | Rules |
| --- | --- | --- |
| `script` | yes | Non-empty string; transported as data, never interpolated into a parent shell command line |
| `shell` | no | Defaults to `powershell`; first release only needs PowerShell |
| `cwd` | no | Defaults to the tool workspace; must exist and be canonicalized before launch |
| `timeout_ms` | no | Defaults to 30,000 ms; long-running work should use `shell_session` |
| `expected_effect` | yes | `observe`, `modify`, or `destructive`; model declaration used for explanation and conservative policy evaluation |
| `rationale` | yes | Concrete user-facing description of what the script reads or changes |

Future fields such as environment overrides must be added deliberately. Secrets
must not be accepted in a field that the journal records verbatim.

### 7.3 Output schema

```jsonc
{
  "commandId": "cmd-20260714-7f3a...",
  "status": "completed",
  "phase": "execution",
  "shell": "powershell",
  "cwd": "D:\\Documents\\MANTARA\\AI COMPAGNON APP",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "timedOut": false,
  "cancelled": false,
  "durationMs": 842,
  "parseErrors": []
}
```

Allowed `status` values:

- `completed`: exited with code 0;
- `failed`: validation, launch, or non-zero-exit failure;
- `timed_out`: timeout fired and the process tree was terminated;
- `cancelled`: user or runtime cancellation terminated the process tree.

Allowed `phase` values:

- `validation`;
- `launch`;
- `execution`;
- `termination`.

The result MUST always contain booleans for truncation, timeout, and
cancellation. `exitCode` is `null` when no reliable exit code exists.

### 7.4 Execution requirements

- Reuse or extract the proven parts of `runSupervisedProcess`:
  `shell: false`, discrete executable/args, stdin transport, bounded output,
  timeout, cancellation, and process-tree termination.
- Do not put generated script text in `powershell.exe -Command <text>`.
- Use `-NoProfile` and `-NonInteractive` for one-shot execution.
- Keep stdout and stderr separate.
- Correctly surface native executable exit failures as well as PowerShell
  errors.
- Preserve Unicode without relying on the console code page.
- Include a configurable output cap. The existing 64 KiB cap is an acceptable
  initial default if both truncation flags are accurate.
- A timeout or output cap must not leave descendants running silently.
- Tool-provider code must journal the actual terminal status, not simply that
  the runner returned an object.

## 8. `shell_session` contract

### 8.1 Purpose

Manage a stateful terminal process for work that cannot be represented as a
bounded one-shot execution.

The tool has one action per call:

```text
open | write | read | interrupt | close
```

### 8.2 Open

```jsonc
{
  "action": "open",
  "shell": "powershell",
  "cwd": "D:\\project",
  "rationale": "Start a persistent development shell for the requested task."
}
```

Returns an opaque `sessionRef`, the resolved shell and cwd, and an initial
output cursor. Session refs are scoped to the Voxara conversation or pilot and
must include a generation so stale refs fail closed after a host restart.

### 8.3 Write

```jsonc
{
  "action": "write",
  "session_ref": "sh1-g3",
  "input": "npm run dev",
  "submit": true,
  "expected_effect": "modify",
  "rationale": "Start the development server requested by the user."
}
```

`input` travels directly to the PTY stream. It is not converted to simulated
keyboard events, so keyboard layout is irrelevant. `submit=true` appends the
shell's Enter sequence exactly once.

The result means only `input_written`; command completion is established by a
later `read`, explicit prompt detection, exit, or another protocol marker.

### 8.4 Read

```jsonc
{
  "action": "read",
  "session_ref": "sh1-g3",
  "cursor": 1204,
  "wait_ms": 1000,
  "max_chars": 8000
}
```

Returns output after the supplied cursor, the next cursor, process state, and
whether the ring buffer discarded older data. Re-reading the same cursor must
not consume or duplicate process input.

`wait_ms` is bounded. The agent must use repeated reads for long jobs instead
of blocking the voice loop.

### 8.5 Interrupt and close

- `interrupt` sends the platform-appropriate interrupt first and escalates to
  process-tree termination after a bounded grace period.
- `close` performs graceful shell exit when possible, then terminates after a
  grace period.
- Closing an already closed session is idempotent.
- Process exit returns the exit code and remaining buffered output.

### 8.6 Lifecycle

- Initial concurrency limit: one stateful shell session per conversational
  lane and one per pilot lane.
- Sessions do not survive Voxara process death in the first release.
- Startup recovery marks orphaned session records interrupted; it must not
  pretend they are still controllable.
- An idle expiry MAY be added, but active user-requested servers must not be
  killed without a clear policy and user-visible event.

## 9. Desktop text input contract

### 9.1 Literal text

Implement a trusted `Send-UnicodeText` primitive in the desktop host:

- construct native `INPUT` keyboard events;
- send UTF-16 units with `KEYEVENTF_UNICODE` and `wVk=0`;
- handle surrogate pairs correctly;
- check the `SendInput` return count;
- surface UIPI/integrity-level failure as a transport error;
- verify the intended target is foreground immediately before and after the
  batch;
- abort if the target changes;
- never infer that the application accepted or executed the text.

Named shortcuts such as `ctrl+s` remain a separate path because they represent
physical keys and modifiers, not literal Unicode text.

### 9.2 Clipboard fallback

A clipboard-paste fallback MAY exist for applications that reject
`VK_PACKET`, subject to all of these requirements:

- it is not the default path;
- the previous clipboard content is restored in `finally` when possible;
- clipboard mutation is journaled;
- sensitive text is not placed on the clipboard without explicit policy;
- the result reports `paste_sent`, not application success.

### 9.3 Terminal routing

After `shell_exec` is available, agent-facing guidance MUST say:

- use `shell_exec` for normal commands;
- use `shell_session` for stateful or interactive terminal work;
- use `desktop_act` to open, focus, or type literal text in a GUI;
- do not use desktop keyboard typing as the default way to execute a command.

The legacy `desktop_act type submit=true` route may remain temporarily for
backward compatibility, but it must be documented as transport-only and must
not return command success. Remove it from normal model guidance once
`shell_session` is shipped.

## 10. Routing rules for agents

| User intent | Required primary route |
| --- | --- |
| "Show my RAM and CPU usage" | `shell_exec` |
| "Run the tests" | `shell_exec` if bounded; `shell_session` if long-running or interactive |
| "Start the dev server and keep watching it" | `shell_session` |
| "Open PowerShell" | `desktop_act open_app` |
| "Type this text in Notepad" | `desktop_act type` using Unicode input |
| "Run this and show me a visible terminal" | Execute through the shell service; visible terminal is attached/mirrored or launched with discrete arguments, never trusted as the result channel |
| "Press Ctrl+S" | `desktop_act keys` |

If a request can be satisfied through `shell_exec`, the model must not open a
terminal merely to simulate typing.

## 11. Safety and approval policy

### 11.1 Effect levels

Shell calls use these semantic levels:

- `observe`: reads state and produces no intended external mutation;
- `modify`: creates or changes files, configuration, packages, processes, or
  remote state in a bounded/reversible way;
- `destructive`: deletes, overwrites irreversibly, terminates important work,
  changes security settings, or has unbounded/high-impact effects.

The model-provided `expected_effect` is an assertion, not proof.

### 11.2 Trusted policy behavior

- Trusted policy may upgrade `observe` to `modify` or `destructive`.
- Trusted policy must not downgrade a model-declared effect.
- A parser failure, unknown construct, obfuscation, dynamic invocation, or an
  unrecognized command defaults to sensitive handling.
- It is acceptable for the first implementation to classify every arbitrary
  shell script as sensitive. False positives are preferable to a blanket grant.
- A future read-only classifier may grant `observe` only for scripts it can
  prove fall inside a conservative set. Such a classifier is a privilege
  optimization, not a capability allowlist.
- `modify` and `destructive` confirmations name concrete effects, paths,
  processes, or remote systems. A generic "take control" prompt is not enough.
- Approval replay executes the stored `commandId` once; the model does not
  reconstruct the approved script.

### 11.3 Secrets

- Do not journal environment variables or command arguments known to contain
  passwords, API keys, tokens, or private keys.
- Tool descriptions must discourage putting secrets directly in command text.
- If secret input support is later added, it needs a non-echoing, non-journaled
  channel and separate approval semantics.

## 12. Error taxonomy

Tool results and journals MUST use stable categories:

| Category | Meaning | Agent behavior |
| --- | --- | --- |
| `validation_error` | Script or parameters invalid before launch | Fix once using exact parser diagnostics |
| `policy_blocked` | Awaiting grant/confirmation or denied | Relay concrete reason and stop |
| `launch_error` | Shell executable or cwd unavailable | Report environment problem |
| `transport_error` | PTY/stdin/Unicode input delivery failed | Do not rewrite command syntax |
| `nonzero_exit` | Process ran and returned failure | Inspect stdout/stderr and correct command if appropriate |
| `timeout` | Budget expired and process tree was terminated | Offer longer/session route when appropriate |
| `cancelled` | User/runtime interrupted the work | Acknowledge cancellation; do not auto-retry |
| `target_lost` | GUI window closed or focus binding became stale | Re-resolve only with user intent preserved |
| `output_truncated` | Result exceeded cap | State truncation and rerun with a narrower query if needed |

The agent must never convert any of these into an unsupported success claim.

## 13. Journaling and observability

Every shell action must have correlated start and terminal events containing:

- `commandId` or `sessionRef`;
- Voxara conversation/pilot session id and lane;
- shell and resolved cwd;
- policy decision and effect level;
- start and end timestamps;
- terminal status, phase, exit code, timeout/cancel flags, duration;
- stdout/stderr byte counts and truncation flags;
- redacted command/rationale according to the secret policy.

Do not journal an execution as `success` merely because a process object was
returned. The journal's terminal outcome must match the structured tool result.

For desktop typing, journal `input_sent` or `paste_sent`. Application success
requires a separate observation and must not be synthesized by the desktop
host.

`llmtest control doctor` should eventually report:

- desktop-host health;
- active foreground keyboard layout;
- Unicode input capability/canary result;
- one-shot shell runner health;
- ConPTY/session availability;
- process-tree termination capability.

## 14. Implementation plan

### Slice R0 - Reproducer and contract tests

Before changing the transport:

1. Add a pure unit test for the result-state contract.
2. Add a Windows-only integration harness that sends a punctuation canary to a
   retrievable text target such as Notepad.
3. Run the canary with French and US foreground layouts when available.
4. Record the current `SendKeys` failure so the test demonstrably fails before
   the fix and passes after it.

Canary text must include at least:

```text
| \ { } [ ] % @ $ ^ & ; : " ' < > ( ) = + - _ é à ç
```

### Slice R1 - Unicode desktop input hotfix

1. Add the native `SendInput` declarations and `Send-UnicodeText` helper to the
   desktop host.
2. Replace `SendKeys` for literal text only.
3. Retain a separate named-key/chord path.
4. Change desktop result naming from implied success to delivery state.
5. Add tests for return-count failure, focus loss, surrogate pairs, accents,
   and punctuation.

This slice removes the immediate layout corruption but does not make GUI
terminal execution authoritative.

### Slice R2 - Structured `shell_exec`

1. Extract a shell service around the supervised process runner.
2. Implement PowerShell parse preflight.
3. Implement the input/output contract in section 7.
4. Default cwd to the tool workspace.
5. Add policy and journal support.
6. Register the tool on agentic chat and voice surfaces.
7. Rewrite tool guidance so ordinary terminal work selects `shell_exec`.

R2 is the minimum slice that solves the product requirement robustly.

### Slice R3 - Stateful `shell_session`

1. Add the ConPTY-backed session manager.
2. Implement open/write/read/interrupt/close and cursor-based output.
3. Add lane ownership, stale-ref generation, concurrency, cancel, and cleanup.
4. Cover persistent cwd, environment, long-running output, prompts, and
   process-tree shutdown.

### Slice R4 - Policy and agent-behavior hardening

1. Remove desktop terminal typing from preferred tool guidance.
2. Add the conservative shell effect policy.
3. Add at-most-once `commandId` replay protection.
4. Add the two-failure diagnostic rule to agent/pilot guidance.
5. Correct or supersede documentation that equates `submitted` with executed.

### Slice R5 - Visible terminal integration

If a visible terminal remains a product requirement, implement presentation on
top of the managed shell channel. Acceptable approaches include attaching a
terminal UI to the managed ConPTY or launching a visible PowerShell process
with discrete arguments. The visible window must not replace structured result
capture.

## 15. Required tests

### 15.1 Unit tests

- PowerShell parser diagnostics are returned without execution.
- Workspace cwd default and explicit cwd resolution.
- Invalid/missing cwd fails before launch.
- Exit 0, non-zero exit, stderr-only failure, no-output success.
- Timeout, cancel, and process-tree kill.
- Separate stdout/stderr truncation flags.
- Unicode decoding across chunk boundaries.
- `commandId` at-most-once replay.
- Journal terminal outcome equals tool terminal outcome.
- Policy cannot downgrade declared risk.
- Unknown scripts fail closed.
- Desktop Unicode-event construction, including surrogate pairs.
- Partial `SendInput` return is a transport error.

### 15.2 Windows integration tests

- Exact punctuation canary under French layout.
- Exact punctuation canary under US layout.
- At least one real Windows Terminal or PowerShell console smoke test.
- Complex calculated-property PowerShell command executes unchanged.
- `systeminfo | findstr ...` preserves the pipeline even if localization makes
  the query return no matching lines.
- Focus change during GUI input fails without claiming success.
- Elevated-target/UIPI failure is explicit.
- Timeout leaves no known descendant process running.

### 15.3 Stateful-session tests

- `Set-Location` persists across writes.
- A session environment variable persists.
- Incremental output cursors neither lose nor duplicate retained data.
- A long-running server remains controllable.
- Interrupt stops the foreground job.
- Close is idempotent.
- Host restart makes old refs stale.
- Conversation and pilot lanes cannot write to each other's sessions.

### 15.4 Agent-loop tests

- A simple terminal request selects `shell_exec`, not `desktop_act`.
- A long-running request selects `shell_session`.
- A failed command is not described as successful.
- A blocked exact call is not regenerated or duplicated after approval.
- Two same-class failures trigger diagnosis instead of endless variants.
- Tool-result objects remain intact in model history.

## 16. Acceptance scenarios

All scenarios below must pass before the robust terminal fix is declared
complete.

### A. Original system-status request

From voice mode, ask in French for used RAM and CPU load. Voxara uses
`shell_exec`, receives structured output, and speaks actual values. No terminal
window or screenshot is required. A calculated-property or JSON-producing
PowerShell script with pipes, braces, brackets, `$`, and `%` must execute
unchanged.

### B. Visible terminal request

Ask Voxara to open PowerShell. The window opens. Ask it to type the punctuation
canary without submitting. The displayed text is exact on the French layout.
The result is described as typed/sent, not executed.

### C. Command failure

Run a command that intentionally exits non-zero. Voxara reports failure with
the exit code and useful stderr. Journal outcome is failure.

### D. Timeout and cleanup

Run a process longer than the one-shot timeout. The result is `timed_out`, the
full process tree is terminated, and Voxara suggests `shell_session` if the
user intended a long-running job.

### E. Stateful development task

Open a shell session, change directory, set an environment variable, start a
development server, read incremental output, and interrupt it. State persists,
output is not duplicated, and the voice loop remains responsive.

### F. Approval replay

Trigger a sensitive shell action. The action is blocked before execution,
explained concretely, and after the user's yes the exact stored `commandId`
runs once. No duplicated command or half-entered terminal state exists.

## 17. Likely code map

Coding agents should confirm names against the repository, but the expected
change surface is:

- `src/control/desktopHost.ts` - replace literal-text SendKeys transport;
- `src/control/policy.ts` - shell intents and conservative effect handling;
- `src/control/types.ts` - structured shell/session types;
- `src/control/shell.ts` or a small `src/control/shell/` module - one-shot and
  session service;
- `src/delegation/processRunner.ts` - reuse or extract supervision primitives;
- `src/providers/tools/shellExec.ts` - one-shot tool provider;
- `src/providers/tools/shellSession.ts` - stateful session tool provider;
- `src/providers/tools/desktopAct.ts` - revised contract and guidance;
- `src/providers/tools/index.ts` - registration;
- `src/engine/agentLoop.ts` and pilot history code - structured tool results and
  retry behavior if needed;
- `src/commands/control.ts` - doctor checks;
- `src/commands/voiceChat.ts` and agent-chat tool lists - expose new tools;
- `tests/desktopHost.test.ts` - Unicode input tests;
- new shell service/tool/integration tests;
- `README.md`, `.env.example`, and phase documentation after behavior ships.

Avoid a broad rewrite. Preserve unrelated browser, UIA, voice, memory, and
delegation behavior.

## 18. Migration and compatibility

1. Ship R1 without removing current desktop actions.
2. Ship `shell_exec` additively and change agent guidance in the same change.
3. Keep `control_code browser_js` unchanged.
4. Decide after R2 whether PowerShell `control_code` becomes an alias/internal
   implementation of `shell_exec` or remains a stricter raw-code escape hatch.
   There must not be two indistinguishable PowerShell tools with conflicting
   approval semantics.
5. Keep legacy `desktop_act type submit=true` callable until stateful sessions
   exist, but stop advertising it for ordinary commands.
6. Remove or formally deprecate the legacy route only after voice and agent
   regression tests prove the replacement.

## 19. Definition of done

The work is complete only when all of the following are true:

- the original French-layout corruption is covered by a failing-before,
  passing-after integration test;
- `SendKeys` is no longer the primary literal-text transport;
- ordinary command requests route through `shell_exec`;
- shell results are structured and journaled accurately;
- non-zero, timeout, cancel, truncation, and launch failures are distinguishable;
- cwd is explicit and defaults to the workspace;
- at-most-once approval replay is tested;
- stateful terminal tasks are supported or, if delivered in a later agreed
  slice, the limitation is explicit and ordinary one-shot tasks are already
  robust;
- targeted and full repository tests pass;
- TypeScript build passes;
- this document and user-facing documentation match the shipped behavior;
- a live French voice acceptance run succeeds without screenshots or manual
  user diagnosis.

## 20. Instructions for future coding agents

1. Read this document before changing terminal execution or desktop typing.
2. Inspect the current dirty worktree and preserve unrelated user changes.
3. Implement in the R0-R5 order unless a newer user instruction changes the
   sequence.
4. Do not patch model prompts as a substitute for fixing the transport and
   result contract.
5. Do not mark a slice complete from mocked tests alone; the original defect is
   Windows- and layout-specific.
6. When reporting progress, distinguish hotfix completion from full robust
   terminal completion.
7. If a decision here proves infeasible, stop, document the concrete constraint,
   propose the smallest safe deviation, and update this source of truth only
   after that decision is accepted.
