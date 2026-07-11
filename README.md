# Voxara — Local-first AI companion CLI

Voxara is a TypeScript command-line application for chatting with, testing, and evaluating large language models. It supports Google Gemini, GitHub Models, and local Ollama models, and includes an optional real-time voice loop with local speech-to-text and text-to-speech.

The project currently provides:

- Streaming text chat and persistent agent chat
- Google Gemini, GitHub Models, and Ollama providers
- Prompt, benchmark, model-comparison, and multi-turn conversation tests
- Agent tool-use tests with sandboxed file access
- RAG tests with faithfulness and hallucination checks
- Editable runtime prompts under `prompts/`
- Local French/English voice chat with VAD and barge-in
- Local STT through faster-whisper or whisper.cpp
- Local TTS through Piper, Supertonic, or Qwen3-TTS

> Voice capture currently targets Windows and uses FFmpeg DirectShow. The text, agent, RAG, and evaluation features only require Node.js and a configured LLM provider.

## Requirements

### Core application

- Node.js 18 or newer
- npm
- One LLM provider:
  - a Google Gemini API key;
  - a GitHub personal access token with access to GitHub Models; or
  - a running local Ollama server (no API key required).

### Optional voice features

- Windows
- FFmpeg available on `PATH`
- A microphone and audio output device
- Python 3.11 or 3.12 for the faster-whisper or Qwen3-TTS sidecars
- An NVIDIA/CUDA environment for the default GPU faster-whisper configuration, or a CPU-compatible configuration

## Quick start

Install dependencies and create a local configuration:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and configure one of the following providers.

### Google Gemini

```env
LLMTEST_PROVIDER=google
GOOGLE_API_KEY=your_api_key
GOOGLE_MODEL=gemini-2.0-flash
```

### GitHub Models

```env
LLMTEST_PROVIDER=github
GITHUB_TOKEN=your_personal_access_token
GITHUB_MODEL=gpt-4o-mini
```

### Ollama

```env
LLMTEST_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
```

Make sure the selected Ollama model is installed and the Ollama server is running.

Validate the configuration, then start chatting:

```powershell
npm run dev -- config
npm run dev -- validate
npm run dev -- chat
```

For a compiled build:

```powershell
npm run build
node dist/cli.js chat
```

## CLI commands

Run `npm run dev -- <command>` during development or `node dist/cli.js <command>` after building.

| Command | Purpose |
| --- | --- |
| `config` | Show the resolved configuration and its sources. |
| `validate` | Check the selected provider credentials and model. |
| `models` | List models available from the selected provider. |
| `prompt <text>` | Send one prompt, optionally with an image or system prompt. |
| `chat` | Start a persistent streaming text chat. |
| `agent-chat` | Start an interactive chat with tools and optional document context. |
| `run <file>` | Run a benchmark suite. |
| `compare <file> --models <a,b>` | Compare a suite across multiple models. |
| `convo <file>` | Run scripted multi-turn conversation tests. |
| `agent <file>` | Run tool-use and file-assertion tests. |
| `rag <file>` | Run document-grounded RAG tests. |
| `prompts check` | Validate the editable prompt files and template variables. |
| `shell` | Start the persistent interactive REPL. |
| `voice-check` | Diagnose microphone, playback, VAD, STT, and TTS. |
| `voice-chat` | Start the real-time voice conversation loop. |
| `tts-compare [text]` | Compare the installed local TTS engines and voices. |

Use `npm run dev -- <command> --help` to see all options for a command.

Examples:

```powershell
npm run dev -- prompt "Summarize the benefits of local inference" --temperature 0.2
npm run dev -- prompt "Describe this image" --image .\photo.png
npm run dev -- agent-chat --tools calculator,file_read --docs .\context.txt --sandbox .\sandbox
npm run dev -- run .\tests\suites\smoke.json
npm run dev -- compare .\tests\suites\smoke.json --models gemini-2.0-flash,gemini-2.5-flash
```

Built-in agent tools are `calculator`, `file_read`, `file_write`, and `get_current_time`. Use `--sandbox <dir>` to constrain file operations to a specific directory.

## Voice setup

The default voice stack uses faster-whisper for STT and Piper for CPU-based TTS.

1. Install FFmpeg and confirm that `ffmpeg -version` works.
2. Set up the local speech engines:

```powershell
npm run stt:setup
npm run tts:piper:setup
```

3. In a separate terminal, start faster-whisper:

```powershell
npm run stt:start
```

4. Run the audio diagnostics, then start a conversation:

```powershell
npm run dev -- voice-check
npm run dev -- voice-chat
```

The first faster-whisper launch may download model weights and take longer than subsequent starts.

Useful alternatives:

```powershell
# Install the CPU-based Supertonic TTS engine
npm run tts:supertonic:setup

# Compare installed TTS providers
npm run dev -- tts-compare "Bonjour, ceci est un test."

# Start voice chat with local tools enabled
npm run dev -- voice-chat --agent --tools calculator,file_read --sandbox .\sandbox
```

Select engines in `.env`:

```env
VOICE_LANGUAGE=fr
VOICE_STT_PROVIDER=faster-whisper
VOICE_STT_BASE_URL=http://localhost:7862
VOICE_TTS_PROVIDER=piper
PIPER_BINARY_PATH=./tools/piper/bin/piper.exe
PIPER_VOICE=./models/piper/fr_FR-siwis-medium.onnx
VOICE_BARGE_IN=true
```

Supported STT providers are `faster-whisper` and `whisper-cpp`. Supported TTS providers are `piper`, `supertonic`, and `qwen3-tts`. See [`.env.example`](.env.example) for every voice, timeout, chunking, and VAD setting.

During `voice-chat`, the following terminal commands are available:

| Command | Action |
| --- | --- |
| `/exit` | End the session. |
| `/mute`, `/unmute` | Disable or restore microphone listening. |
| `/interrupt` | Stop the current spoken response. |
| `/provider <google\|github\|ollama>` | Change provider for subsequent turns. |
| `/model <name>` | Change the active model. |
| `/tts <piper\|supertonic\|qwen3>` | Change TTS engine. |
| `/tts-voice <name>` | Change the current TTS voice. |
| `/reload-prompts` | Reload prompt files without rebuilding. |
| `/voice-style` | Display the current voice-style prompt. |
| `/debug on`, `/debug off` | Toggle debug output. |
| `/tools all\|none\|<a,b>` | Change active tools in agent mode. |

Voice session events and latency metrics are written as JSONL files under `~/.llmtest/voice-sessions/`.

## Test suite formats

Ready-to-run examples live in `tests/suites/`:

- `smoke.json` — basic prompt and keyword assertions
- `convo-smoke.json` — multi-turn memory tests
- `agent-smoke.json` — expected tool calls and sandbox file assertions
- `rag-smoke.json` — file or inline context with faithfulness checks
- `latency.json` — latency limits and response-quality checks

A minimal benchmark suite looks like this:

```json
{
  "name": "Smoke tests",
  "tests": [
    {
      "id": "capital",
      "prompt": "What is the capital of France?",
      "expect": {
        "keywords": ["Paris"],
        "maxLatencyMs": 5000
      }
    }
  ]
}
```

Run it with:

```powershell
npm run dev -- run .\tests\suites\smoke.json
```

## Runtime prompts

Behavioral prompts are stored in `prompts/` and read at runtime, so they can be changed without rebuilding the application:

| File | Role |
| --- | --- |
| `persona.md` | General assistant personality and conversation behavior. |
| `agent.md` | Tool-use behavior and final-answer rules. |
| `rag.md` | Document-grounded response instructions. |
| `judge.md`, `judge-strict.md` | LLM evaluation instructions. |
| `faithfulness.md` | RAG faithfulness evaluation. |
| `stt-cleanup.md` | Optional speech transcript cleanup. |
| `voice-style.md` | Voice-design instructions for compatible TTS providers. |

Validate prompt files after editing them:

```powershell
npm run dev -- prompts check --debug
```

Set `PROMPTS_DIR` to load prompts from another directory.

## Configuration resolution

Configuration is resolved in this order, from highest to lowest priority:

1. CLI overrides such as `--key` and `--model`
2. Existing process environment variables
3. The project-local `.env`
4. The global `~/.llmtest/.env`
5. Built-in defaults

Never commit `.env`; it is already ignored by the project. Use `.env.example` as the safe configuration template.

## Development

```powershell
# Type-check and compile to dist/
npm run build

# Run all Jest tests
npm test

# Run the CLI directly from TypeScript
npm run dev -- --help
```

The automated tests mock external LLM, speech, and audio boundaries; they do not require a live API, microphone, or GPU.

## Project structure

```text
src/
  audio/          Microphone capture, playback, VAD, turn detection, interruption
  commands/       CLI command handlers
  display/        Ink/React terminal UI components
  engine/         Agent execution loop
  evaluation/     LLM-as-judge evaluation
  prompts/        Prompt loading, interpolation, and validation
  providers/      Gemini, GitHub Models, Ollama, and built-in tools
  rag/            Document loading, context building, and faithfulness judging
  session/        Persistent text, agent, and voice session data
  speech/         Replaceable STT and TTS providers
  validation/     JSON Schema validation
docs/             Voice architecture, implementation phases, and troubleshooting
prompts/          User-editable runtime prompt templates
tests/            Jest tests, fixtures, and example suites
tools/            Local speech service and model setup scripts
```

## Troubleshooting

| Problem | Check |
| --- | --- |
| Missing API key | Confirm `LLMTEST_PROVIDER` and its matching key in `.env`, then run `config`. |
| Ollama connection fails | Confirm Ollama is running, the model is installed, and `OLLAMA_BASE_URL` is correct. |
| No microphone is detected | Confirm FFmpeg is on `PATH`; run `voice-check --device "Exact device name"`. |
| No transcription | Start the faster-whisper service or verify the whisper.cpp binary/model paths. |
| No synthesized speech | Verify the selected TTS provider and its model/assets paths. |
| False interruptions | Use headphones, raise `VOICE_VAD_THRESHOLD`, or calibrate with `voice-check`. |
| Quiet speech is ignored | Lower `VOICE_VAD_THRESHOLD` or `VOICE_VAD_MIN_THRESHOLD` gradually. |
| First STT response is slow | Allow the service to finish downloading and warming its model. |

More detailed voice guidance is available in [`docs/guide-rapide-utilisation-audio.md`](docs/guide-rapide-utilisation-audio.md) and [`docs/audio-conversation-spec.md`](docs/audio-conversation-spec.md).
