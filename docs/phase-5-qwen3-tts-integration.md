# Phase 5: Qwen3-TTS Integration

Status: Complete

Completed: 2026-07-09

## Summary

The voice roadmap now has a replaceable local text-to-speech layer and a first Qwen3-TTS adapter. `voice-check` validates the configured TTS service, loads `prompts/voice-style.md`, synthesizes a short French or English sentence when the backend is ready, and sends the generated audio through the cancellable playback queue.

## Changes

- Added `src/speech/tts/types.ts` for TTS setup checks, synthesis options, audio results, chunk events, and provider config.
- Added `src/speech/tts/ITTSProvider.ts` with a replaceable provider interface.
- Added `src/speech/tts/qwen3Tts.ts` with:
  - Qwen language mapping from `VOICE_LANGUAGE=fr|en` to `French|English`
  - local service setup checks
  - `POST /v1/audio/speech` support with `POST /synthesize` fallback
  - voice design prompt forwarding via `instructions` and `instruct`
  - WAV byte and JSON `audio_base64` response parsing
  - clear errors for backend failures, timeout, cancellation, and malformed responses
- Added `src/speech/tts/factory.ts` for TTS provider construction, `voice-style` prompt loading, response chunking, and playback queue wiring.
- Updated `voice-check` to:
  - validate the Qwen3-TTS backend
  - show voice-style prompt loading
  - synthesize and play a short language-specific test sentence
  - keep TTS skippable with `--skip-tts`
- Updated `README.md` with the active TTS diagnostic behavior and local service contract.
- Updated `docs/audio-conversation-spec.md` roadmap status.
- Added mocked Qwen3-TTS service and playback tests in `tests/ttsQwen3.test.ts`.

## Verification

Commands run:

```bash
npm run build
npm test -- --runInBand
$env:VOICE_STT_MODEL_PATH='package.json'; $env:VOICE_STT_BINARY_PATH='node'; npm run dev -- voice-check --skip-record --skip-playback --skip-tts
```

Result:

- Build passed.
- Test suite passed: 8 suites, 34 tests.
- `voice-check` command wiring passed with microphone/playback/TTS skipped and STT setup pointed at harmless local stand-ins.

## Notes For Phase 6

The current adapter supports chunked synthesis by synthesizing text chunks sequentially. If the chosen Qwen3-TTS runtime exposes true streaming audio, Phase 6 can extend the same `synthesizeChunks` event interface without changing the voice loop call site.
