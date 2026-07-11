# Phase 4: STT Integration

Status: Complete

Completed: 2026-07-09

## Summary

The voice roadmap now has a replaceable local speech-to-text layer and a first whisper.cpp adapter. `voice-check` validates the configured Whisper backend and transcribes the recorded microphone sample when the backend is available.

## Changes

- Added `src/speech/stt/types.ts` for transcript events, STT setup checks, and provider config.
- Added `src/speech/stt/ISTTProvider.ts` with a replaceable provider interface.
- Added `src/speech/stt/whisperCpp.ts` with:
  - whisper.cpp subprocess invocation
  - `VOICE_LANGUAGE` mapping to `fr` / `en`
  - WAV preparation for PCM or WAV audio inputs
  - partial, final, error, and end transcript events
  - transcript parsing for timestamped whisper.cpp output
  - clear errors for missing model, missing binary, process exit failure, and cancellation
- Added `src/speech/stt/factory.ts` for STT provider construction and final transcript collection.
- Added `VOICE_STT_BINARY_PATH` config support, defaulting to `whisper-cli`.
- Updated `voice-check` to:
  - validate the STT backend
  - run local transcription against the recorded sample when ready
  - keep reporting other diagnostics if STT fails
- Updated `.env.example` and `README.md` for the whisper.cpp binary setting and STT-enabled diagnostics.
- Added mocked whisper.cpp process tests in `tests/sttWhisperCpp.test.ts`.

## Verification

Commands run:

```bash
npm run build
npm test -- --runInBand
$env:VOICE_STT_MODEL_PATH='package.json'; $env:VOICE_STT_BINARY_PATH='node'; npm run dev -- voice-check --skip-record --skip-playback
```

Result:

- Build passed.
- Test suite passed: 7 suites, 22 tests.
- `voice-check` command path passed with microphone/playback skipped and STT setup pointed at harmless local stand-ins.

## Notes For Phase 5

The STT interface is event-based and should fit the later real-time voice loop. Phase 5 can follow the same pattern for TTS: keep the Qwen3-TTS service behind a provider interface, mock the service boundary in tests, and wire only backend validation plus a short synthesis path into `voice-check`.
