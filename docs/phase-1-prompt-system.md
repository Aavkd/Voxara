# Phase 1 Prompt System

Date: 2026-07-09

Source spec: `docs/audio-conversation-spec.md`

## Summary

Phase 1 is complete. Reusable behavioral prompts now live in editable files under `prompts/`, with runtime loading, explicit variable interpolation, validation, and a `prompts check` CLI command.

## Files Added

- `prompts/persona.md`
- `prompts/agent.md`
- `prompts/rag.md`
- `prompts/judge.md`
- `prompts/judge-strict.md`
- `prompts/faithfulness.md`
- `prompts/stt-cleanup.md`
- `prompts/voice-style.md`
- `src/prompts/promptLoader.ts`
- `src/prompts/templates.ts`
- `src/commands/prompts.ts`
- `tests/promptLoader.test.ts`
- `jest.config.js`

## Files Updated

- `src/rag/contextBuilder.ts`
- `src/evaluation/llmJudge.ts`
- `src/rag/faithfulnessJudge.ts`
- `src/cli.ts`
- `.env.example`

## Behavior Implemented

- `PROMPTS_DIR` resolves the editable prompt directory and defaults to `./prompts`.
- Prompt files are read at runtime, so edits are picked up without rebuilding TypeScript.
- Templates support explicit `{{variable}}` interpolation.
- Missing required variables fail fast.
- Unknown variables fail in debug mode and warn during prompt validation otherwise.
- Missing prompt files use emergency fallback strings with visible warnings.
- RAG, LLM judge, strict judge retry, and faithfulness judge prompts now render through the prompt loader.
- `npm run dev -- prompts check` validates the required prompt files and required variables without calling an LLM.

## Commands Run

- `npm run dev -- prompts check`
  - Result: passed.

- `npm run dev -- prompts check --debug`
  - Result: passed.

- `npm run build`
  - Result: passed.

- `npm test -- --runInBand`
  - Result: passed.
  - Test suites: 1 passed.
  - Tests: 4 passed.

## Notes For Phase 2

- `npm test` now has a real Jest TypeScript test target through `jest.config.js`.
- `AppConfig.provider` still only supports `"google" | "github"`; Phase 2 should extend it to include `"ollama"`.
- `.env.example` now includes `PROMPTS_DIR=./prompts`; Phase 2 should add `OLLAMA_BASE_URL` and `OLLAMA_MODEL`.
