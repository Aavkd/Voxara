# Phase 0 Baseline

Date: 2026-07-09

Source spec: `docs/audio-conversation-spec.md`

## Commands Run

### Initial environment check

- `npm run build`
  - Result: failed before dependency install.
  - Error: `tsc` was not recognized because `node_modules` was absent.

- `npm test`
  - Result: failed.
  - `npx` downloaded Jest transiently, then Jest exited with `No tests found`.

### Dependency installation

- `npm ci`
  - Result: succeeded.
  - Notes:
    - Installed locked dependencies from `package-lock.json`.
    - Reported a React peer dependency warning from Ink's `react-reconciler`.
    - Reported 4 audit vulnerabilities: 1 low, 1 moderate, 1 high, 1 critical.

### Baseline after dependency installation

- `npm run build`
  - Result: passed.
  - Command executed: `tsc`.

- `npm test`
  - Result: failed.
  - Reason: no Jest test files were found.
  - Jest scanned 56 files and matched no `*.test.*`, `*.spec.*`, or `__tests__` files.
  - Existing `tests/` content is JSON suites and fixtures, not Jest tests.

## Required Files Read

- `src/cli.ts`
- `src/types.ts`
- `src/config/loader.ts`
- `src/providers/ILLMProvider.ts`
- `src/commands/chat.ts`
- `src/commands/agentChat.ts`

## Architecture Notes

- `src/cli.ts` uses `commander` and registers the current command surface: `validate`, `prompt`, `chat`, `run`, `agent`, `rag`, `compare`, `convo`, `agent-chat`, `shell`, `config`, and `models`.
- `src/types.ts` defines `AppConfig.provider` as `"google" | "github"`, so later Ollama work will need a type extension.
- `src/config/loader.ts` resolves config from CLI overrides, environment, local `.env`, and global `~/.llmtest/.env`. It currently supports Google and GitHub provider-specific keys and models.
- `src/providers/ILLMProvider.ts` already exposes `streamChat(messages, onChunk)`, which is the right future hook for low-latency spoken responses.
- `src/commands/chat.ts` streams provider responses into the Ink chat UI and persists chat sessions.
- `src/commands/agentChat.ts` wires the existing agent loop, optional tools, optional document context through RAG, and persistent agent sessions.

## Phase 0 Status

- Build baseline: passes after running `npm ci`.
- Test baseline: fails because the repository currently has no Jest unit tests.
- No voice implementation work was started in this phase.
