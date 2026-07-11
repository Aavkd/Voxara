# Phase 6: Full Real-Time Voice Loop

Status: Complete

Completed: 2026-07-09

## Summary

The CLI now exposes `voice-chat`, a first usable local voice conversation loop. It records short microphone windows, detects speech with VAD, transcribes with the configured STT provider, streams the LLM response into chunked TTS, plays audio through the cancellable queue, supports barge-in/manual interruption, and writes JSONL transcript/debug logs.

## Changes

- Added `src/commands/voiceChat.ts` with:
  - `voice-chat` command orchestration
  - configured `VOICE_LANGUAGE=fr|en`
  - startup checks for STT and TTS backends
  - prompt-loaded persona and voice-style instructions
  - streaming LLM chunks into TTS before full response completion
  - barge-in monitoring while assistant audio is active
  - in-session commands: `/exit`, `/mute`, `/unmute`, `/interrupt`, `/provider`, `/model`, `/reload-prompts`, `/voice-style`, and `/debug`
  - latency metrics for LLM first token, TTS first audio, playback stop, and full turn duration
- Added `src/audio/conversationState.ts` for compact voice loop state and per-turn metrics.
- Added `src/audio/interruptController.ts` for VAD-triggered playback stop/flush behavior.
- Added voice transcript JSONL helpers in `src/session/session.ts`.
- Extended shared types in `src/types.ts` for voice transcript events/log metadata.
- Wired `voice-chat` into `src/cli.ts`.
- Added mocked integration tests in `tests/voiceLoop.test.ts` for streaming LLM-to-TTS and interruption behavior.
- Updated `docs/audio-conversation-spec.md` roadmap status.

## Verification

Commands run:

```bash
npm test
npm run build
```

Result:

- Build passed.
- Test suite passed: 9 suites, 37 tests.

## Notes For Phase 7

The first loop routes through plain `streamChat`. Agent/tool support should remain opt-in in Phase 7 so the low-latency voice path stays stable.
