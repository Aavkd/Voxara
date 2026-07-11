# Phase 7: Agentic Voice Mode

Status: Complete

Implemented on: 2026-07-09

## Summary

Phase 7 adds opt-in agent/tool support to the CLI voice conversation loop.

Plain `voice-chat` keeps the low-latency streaming provider-to-TTS path from Phase 6. Agentic voice mode is enabled explicitly with:

```bash
npm run dev -- voice-chat --agent
```

In agent mode, each final user transcript is sent through the existing `runAgentLoop` tool-use engine. Tool activity is displayed compactly in the CLI and written to the voice transcript log. The audio channel speaks only the final agent answer so tool progress does not overwhelm the conversation.

## User-Facing Behavior

- `voice-chat --agent` enables agent/tool support.
- `--tools <list>` restricts tools by comma-separated name.
- `--tools all` enables every registered tool.
- `--tools none` disables tools while keeping agent prompting enabled.
- `--sandbox <dir>` selects the sandbox for file tools.
- `--agent-max-steps <n>` sets the per-turn tool loop limit.
- In-session `/tools` shows or changes the active tool set.

The default tool set in agent mode is every registered tool from `src/providers/tools/`.

## Implementation Notes

- Added `startVoiceAgentAssistantTurn` beside the plain streaming voice turn in `src/commands/voiceChat.ts`.
- Reused `runAgentLoop` and existing tool registry helpers.
- Added an optional `onToolResult` callback to `runAgentLoop` so voice mode can display tool results and tool errors.
- Loaded both `prompts/persona.md` and `prompts/agent.md` when building voice-agent prompts.
- Kept plain voice chat unchanged when `--agent` is not set.

## Verification

```bash
npm run build
npm test
```

Both commands passed after implementation.
