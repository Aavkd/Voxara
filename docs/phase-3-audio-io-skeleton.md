# Phase 3: Audio IO Skeleton

Status: Complete

Completed: 2026-07-09

## Summary

The voice roadmap now has an additive audio foundation for CLI diagnostics and later real-time voice work. The implementation defines stable interfaces for microphone capture, playback output, VAD, turn detection, and cancellable playback while keeping system-specific audio behind adapters.

## Changes

- Added `src/audio/types.ts` for microphone, playback, VAD, recording, and audio state interfaces.
- Added `src/audio/wav.ts` for PCM16 tone/silence generation and WAV encode/decode helpers.
- Added `src/audio/player.ts` with:
  - `CancellablePlaybackQueue`
  - `SystemAudioOutput`
  - `play`, `stop`, and `flush` semantics
- Added `src/audio/vad.ts` with an energy-based PCM16 VAD.
- Added `src/audio/turnDetector.ts` for grouping VAD events into turn-start, turn-audio, and turn-end events.
- Added `src/audio/audioStateMachine.ts` covering idle, listening, speaking, interrupted, and error states.
- Added `src/audio/microphone.ts` with a Windows `ffmpeg` DirectShow microphone adapter and device parser.
- Added `llmtest voice-check` / `npm run dev -- voice-check` for audio diagnostics.
- Added voice config loading for language, audio sample rate, barge-in, STT/TTS placeholders, and VAD thresholds.
- Updated `.env.example` and `README.md` with voice settings and diagnostics usage.
- Added mocked/unit tests for state transitions, playback cancellation, VAD/turn detection, and microphone-device parsing.

## Verification

Commands run:

```bash
npm run build
npm test
npm run dev -- voice-check --skip-record --skip-playback
```

Result:

- Build passed.
- Test suite passed: 6 suites, 15 tests.
- `voice-check` command path passed with hardware checks skipped.

## Notes For Phase 4

Phase 4 can build the Whisper STT adapter on top of the recorded WAV/PCM shape already exposed by `MicrophoneCapture`. Automated STT tests should mock the process boundary rather than requiring a local Whisper binary or microphone in CI.
