/**
 * Config Loader — resolves AppConfig from multiple sources.
 *
 * Priority order (highest → lowest):
 *   1. CLI flag overrides (passed as partial object)
 *   2. Process environment variables
 *   3. Local .env file in CWD
 *   4. Global .env at ~/.llmtest/.env
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { AppConfig, VoiceConfig, VoiceLanguage } from "../types";

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".llmtest");
const GLOBAL_ENV_PATH = path.join(GLOBAL_CONFIG_DIR, ".env");
const LOCAL_ENV_PATH = path.join(process.cwd(), ".env");

const DEFAULT_MODEL_GOOGLE = "gemini-2.0-flash";
const DEFAULT_MODEL_GITHUB = "gpt-4o-mini";
const DEFAULT_MODEL_OLLAMA = "qwen3:8b";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_LOG_LEVEL: AppConfig["logLevel"] = "info";
const DEFAULT_PROVIDER: AppConfig["provider"] = "google";
const DEFAULT_VOICE_LANGUAGE: VoiceLanguage = "fr";
const DEFAULT_VOICE_STT_PROVIDER = "faster-whisper";
const DEFAULT_VOICE_STT_BINARY_PATH = "whisper-cli";
const DEFAULT_VOICE_STT_MODEL_PATH = "./models/whisper/ggml-large-v3-turbo.bin";
const DEFAULT_VOICE_STT_BASE_URL = "http://localhost:7862";
// Per-utterance transcription budget (ms). Warm faster-whisper on GPU returns in
// well under a second; the generous default only matters for the first warm call.
const DEFAULT_VOICE_STT_TIMEOUT_MS = 60000;
const DEFAULT_VOICE_TTS_PROVIDER = "piper";
const DEFAULT_VOICE_TTS_BASE_URL = "http://localhost:7861";
const DEFAULT_VOICE_TTS_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign";
// A 1.7B TTS model can take tens of seconds for the first warm inference, so a
// short timeout produces spurious failures. Cold-start (weight download) is
// handled by the server reporting readiness via /health, not by this timeout.
const DEFAULT_VOICE_TTS_TIMEOUT_MS = 10000;
const DEFAULT_PIPER_BINARY_PATH = "./tools/piper/bin/piper.exe";
const DEFAULT_PIPER_VOICE = "./models/piper/fr_FR-siwis-medium.onnx";
const DEFAULT_SUPERTONIC_ASSETS_DIR = "./models/supertonic";
const DEFAULT_SUPERTONIC_VOICE = "F1";
const DEFAULT_VOICE_TTS_CHUNK_MIN = 40;
const DEFAULT_VOICE_TTS_CHUNK_MAX = 260;
const DEFAULT_VOICE_SAMPLE_RATE = 16000;
const DEFAULT_VOICE_BARGE_IN = true;
const DEFAULT_VOICE_DEBUG_TRANSCRIPT = true;
const DEFAULT_PROMPTS_DIR = "./prompts";
const DEFAULT_VOICE_VAD_THRESHOLD = 0.018;
const DEFAULT_VOICE_VAD_SPEECH_MS = 120;
// Natural mid-sentence pauses routinely exceed 500 ms; 900 ms keeps whole
// sentences at the cost of a slightly later end-of-turn.
const DEFAULT_VOICE_VAD_SILENCE_MS = 900;
const DEFAULT_VOICE_VAD_MIN_THRESHOLD = 0.002;
// Barge-in requires more sustained speech than normal listening so TTS speaker
// bleed and short noises do not cut the assistant off.
const DEFAULT_VOICE_BARGEIN_SPEECH_MS = 250;

/**
 * Describes where a config value was resolved from (for printConfig).
 */
interface ConfigSource {
  provider: string;
  apiKey: string;
  model: string;
  logLevel: string;
  ollamaBaseUrl: string;
}

/**
 * Load configuration by merging sources in priority order.
 * Throws a descriptive error if apiKey cannot be resolved from any source.
 */
export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  const externalEnv = { ...process.env };
  const getEnv = (name: string): string | undefined => externalEnv[name] ?? process.env[name];

  // Load .env files into process.env (lower-priority first so higher overwrites)
  // Global .env — only set values not already present
  if (fs.existsSync(GLOBAL_ENV_PATH)) {
    dotenv.config({ path: GLOBAL_ENV_PATH });
  }

  // Local .env — override global
  if (fs.existsSync(LOCAL_ENV_PATH)) {
    dotenv.config({ path: LOCAL_ENV_PATH, override: true });
  }

  // Resolve provider first — determines which key env var to read
  const provider: AppConfig["provider"] =
    overrides?.provider ||
    (getEnv("LLMTEST_PROVIDER") as AppConfig["provider"]) ||
    DEFAULT_PROVIDER;

  const validProviders: AppConfig["provider"][] = ["google", "github", "ollama"];
  const resolvedProvider: AppConfig["provider"] = validProviders.includes(provider)
    ? provider
    : DEFAULT_PROVIDER;

  // Resolve each value with priority: overrides > env > defaults
  let apiKey: string;
  let defaultModel: string;

  if (resolvedProvider === "ollama") {
    apiKey = "";
    defaultModel = DEFAULT_MODEL_OLLAMA;
  } else if (resolvedProvider === "github") {
    apiKey = overrides?.apiKey || getEnv("GITHUB_TOKEN") || "";
    defaultModel = DEFAULT_MODEL_GITHUB;
  } else {
    apiKey = overrides?.apiKey || getEnv("GOOGLE_API_KEY") || "";
    defaultModel = DEFAULT_MODEL_GOOGLE;
  }

  const model =
    overrides?.model ||
    getEnv(getModelEnvVarName(resolvedProvider)) ||
    defaultModel;

  const ollamaBaseUrl =
    getEnv("OLLAMA_BASE_URL") ||
    DEFAULT_OLLAMA_BASE_URL;

  const rawLogLevel =
    overrides?.logLevel ||
    (getEnv("LLMTEST_LOG_LEVEL") as AppConfig["logLevel"]) ||
    DEFAULT_LOG_LEVEL;

  const logLevel = validateLogLevel(rawLogLevel);
  const voice = loadVoiceConfig(overrides?.voice);

  if (!apiKey && resolvedProvider !== "ollama") {
    if (resolvedProvider === "github") {
      throw new Error(
        "No GitHub token found. Set GITHUB_TOKEN via:\n" +
          "  • CLI flag:        --key <your_pat>\n" +
          "  • Environment var: export GITHUB_TOKEN=<your_pat>\n" +
          "  • Local .env:      create .env in the current directory\n" +
          "  • Global .env:     create ~/.llmtest/.env"
      );
    } else {
      throw new Error(
        "No API key found. Set GOOGLE_API_KEY via:\n" +
          "  • CLI flag:        --key <your_key>\n" +
          "  • Environment var: export GOOGLE_API_KEY=<your_key>\n" +
          "  • Local .env:      create .env in the current directory\n" +
          "  • Global .env:     create ~/.llmtest/.env"
      );
    }
  }

  return {
    apiKey,
    model,
    logLevel,
    provider: resolvedProvider,
    ollamaBaseUrl: resolvedProvider === "ollama" ? ollamaBaseUrl : undefined,
    voice,
  };
}

/**
 * Resolve the memory agent's provider/model (spec §6.3). The memory agent is
 * latency-insensitive, so MEMORY_AGENT_PROVIDER / MEMORY_AGENT_MODEL may point
 * it at a cheaper or local model; both default to the main configuration.
 * Any resolution failure (e.g. missing key for the requested provider) falls
 * back to the main config — memory must never break on configuration.
 */
export function loadMemoryAgentConfig(mainConfig: AppConfig): AppConfig {
  const provider = process.env.MEMORY_AGENT_PROVIDER?.trim();
  const model = process.env.MEMORY_AGENT_MODEL?.trim();

  if (!provider && !model) {
    return mainConfig;
  }

  try {
    return loadConfig({
      provider: (provider as AppConfig["provider"]) || mainConfig.provider,
      model: model || undefined,
    });
  } catch {
    return mainConfig;
  }
}

/** Resolve the provider used to describe screenshots for a text-only main model. */
export function loadControlVisionConfig(): AppConfig {
  const rawProvider = (process.env.CONTROL_VISION_PROVIDER || "google")
    .trim()
    .toLowerCase();
  const provider: AppConfig["provider"] =
    rawProvider === "github" || rawProvider === "ollama" ? rawProvider : "google";
  return loadConfig({ provider });
}

/** Maximum screenshot long edge sent to a vision model. */
export function loadControlScreenshotMaxEdge(): number {
  return positiveInteger(
    undefined,
    process.env.CONTROL_SCREENSHOT_MAX_EDGE,
    1568
  );
}

/**
 * Resolve the C2d-3 background briefing provider/model. Explicit briefing
 * values override the memory-agent configuration; invalid overrides degrade
 * to that same safe fallback rather than breaking delegation.
 */
export function loadDelegationBriefConfig(mainConfig: AppConfig): AppConfig {
  const memoryConfig = loadMemoryAgentConfig(mainConfig);
  const provider = process.env.DELEGATION_BRIEF_PROVIDER?.trim();
  const model = process.env.DELEGATION_BRIEF_MODEL?.trim();

  if (!provider && !model) {
    return memoryConfig;
  }
  try {
    return loadConfig({
      provider: (provider as AppConfig["provider"]) || memoryConfig.provider,
      model: model || memoryConfig.model,
    });
  } catch {
    return memoryConfig;
  }
}

const DEFAULT_MEMORY_EPISODE_RETENTION_DAYS = 90;

/**
 * Episodes older than this many days are compacted into quarterly digests by
 * the memory hygiene pass (spec §8.3). Configured via
 * MEMORY_EPISODE_RETENTION_DAYS; invalid values fall back to the default.
 */
export function loadEpisodeRetentionDays(): number {
  return positiveInteger(
    undefined,
    process.env.MEMORY_EPISODE_RETENTION_DAYS,
    DEFAULT_MEMORY_EPISODE_RETENTION_DAYS
  );
}

const DEFAULT_WORKSPACE_DIR = path.join(GLOBAL_CONFIG_DIR, "workspace");

/**
 * Persistent agent workspace — the stable sandbox directory shared by the
 * conversational agent's file tools (agent-chat, voice-chat --agent) and, in
 * later phases, delegated coding agents (phase C2). Configured via
 * LLMTEST_WORKSPACE_DIR; defaults to ~/.llmtest/workspace. The --sandbox CLI
 * flag still overrides it for one session. Callers must run after loadConfig
 * so .env files are loaded.
 */
export function loadWorkspaceDir(): string {
  const raw = process.env.LLMTEST_WORKSPACE_DIR?.trim();
  return path.resolve(raw || DEFAULT_WORKSPACE_DIR);
}

// ── Delegation (phase C2, docs/phase-c2-coding-agent-delegation.md §13) ──

const DEFAULT_DELEGATION_MAX_CONCURRENT = 2;
const DEFAULT_DELEGATION_TIMEOUT_MINUTES = 15;
const DEFAULT_DELEGATION_MAX_TIMEOUT_MINUTES = 60;
const DEFAULT_DELEGATION_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_DELEGATION_ARTIFACT_RETENTION_DAYS = 14;

export interface DelegationEnvConfig {
  enabled: boolean;
  defaultBackend: "auto" | "codex" | "claude";
  codexPath?: string;
  claudePath?: string;
  allowedRoots: string[];
  /** Agent-owned deliverable roots — direct-run write class (C2d §3–§4). */
  agentOwnedRoots: string[];
  maxConcurrent: number;
  defaultTimeoutMinutes: number;
  maxTimeoutMinutes: number;
  maxOutputBytes: number;
  artifactRetentionDays: number;
  /** Program names allowed for manifest `execute` actions (C2c §6.2). */
  allowedPrograms: string[];
  briefProvider?: AppConfig["provider"];
  briefModel?: string;
}

/**
 * Resolve the coding-agent delegation configuration (spec §13). Disabled by
 * default. Allowed roots default to the shared agent workspace so delegated
 * agents and Voxara's own file tools build in the same place. Callers must
 * run after loadConfig/loadVoiceConfig so .env files are loaded.
 */
export function loadDelegationConfig(): DelegationEnvConfig {
  const rawBackend = (process.env.DELEGATION_DEFAULT_BACKEND || "auto")
    .trim()
    .toLowerCase();
  const defaultBackend =
    rawBackend === "codex" || rawBackend === "claude" ? rawBackend : "auto";

  const rawRoots = process.env.DELEGATION_ALLOWED_ROOTS || "";
  const allowedRoots = rawRoots
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => path.resolve(r));

  // Bare program names only (§6.2): a configured path would bypass the
  // manifest validator's basename rule, so it is dropped here.
  const rawPrograms = process.env.DELEGATION_ALLOWED_PROGRAMS || "";
  const allowedPrograms = rawPrograms
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p === path.basename(p));

  const finalAllowedRoots =
    allowedRoots.length > 0 ? allowedRoots : [loadWorkspaceDir()];

  // Agent-owned roots (C2d §10): direct-run deliverable spaces. Defaults to
  // the shared agent workspace. Every entry must sit inside the allowed
  // roots — a violating entry is dropped (visible via `delegates doctor`),
  // never a crash.
  const rawAgentRoots = process.env.DELEGATION_AGENT_OWNED_ROOTS || "";
  const configuredAgentRoots = rawAgentRoots
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => path.resolve(r));
  const normalizeForContainment = (p: string): string =>
    process.platform === "win32" ? p.toLowerCase() : p;
  const insideAllowed = (candidate: string): boolean => {
    const target = normalizeForContainment(candidate);
    return finalAllowedRoots.some((root) => {
      const normalizedRoot = normalizeForContainment(path.resolve(root));
      return (
        target === normalizedRoot ||
        target.startsWith(normalizedRoot + path.sep)
      );
    });
  };
  const agentOwnedRoots = (
    configuredAgentRoots.length > 0 ? configuredAgentRoots : [loadWorkspaceDir()]
  ).filter(insideAllowed);

  return {
    enabled: parseBoolean(undefined, process.env.DELEGATION_ENABLED, false),
    defaultBackend,
    codexPath: process.env.CODEX_CLI_PATH?.trim() || undefined,
    claudePath: process.env.CLAUDE_CLI_PATH?.trim() || undefined,
    allowedRoots: finalAllowedRoots,
    agentOwnedRoots,
    maxConcurrent: positiveInteger(
      undefined,
      process.env.DELEGATION_MAX_CONCURRENT,
      DEFAULT_DELEGATION_MAX_CONCURRENT
    ),
    defaultTimeoutMinutes: positiveInteger(
      undefined,
      process.env.DELEGATION_DEFAULT_TIMEOUT_MINUTES,
      DEFAULT_DELEGATION_TIMEOUT_MINUTES
    ),
    maxTimeoutMinutes: positiveInteger(
      undefined,
      process.env.DELEGATION_MAX_TIMEOUT_MINUTES,
      DEFAULT_DELEGATION_MAX_TIMEOUT_MINUTES
    ),
    maxOutputBytes: positiveInteger(
      undefined,
      process.env.DELEGATION_MAX_OUTPUT_BYTES,
      DEFAULT_DELEGATION_MAX_OUTPUT_BYTES
    ),
    artifactRetentionDays: positiveInteger(
      undefined,
      process.env.DELEGATION_ARTIFACT_RETENTION_DAYS,
      DEFAULT_DELEGATION_ARTIFACT_RETENTION_DAYS
    ),
    allowedPrograms,
    briefProvider: normalizeProvider(process.env.DELEGATION_BRIEF_PROVIDER),
    briefModel: process.env.DELEGATION_BRIEF_MODEL?.trim() || undefined,
  };
}

function normalizeProvider(raw: string | undefined): AppConfig["provider"] | undefined {
  const value = raw?.trim().toLowerCase();
  return value === "google" || value === "github" || value === "ollama"
    ? value
    : undefined;
}

/**
 * Load voice-specific configuration without requiring an LLM API key.
 * This lets audio diagnostics run even when provider credentials are not ready.
 */
export function loadVoiceConfig(overrides?: Partial<VoiceConfig>): VoiceConfig {
  const getEnv = (name: string): string | undefined => process.env[name];

  if (fs.existsSync(GLOBAL_ENV_PATH)) {
    dotenv.config({ path: GLOBAL_ENV_PATH });
  }

  if (fs.existsSync(LOCAL_ENV_PATH)) {
    dotenv.config({ path: LOCAL_ENV_PATH, override: true });
  }

  return {
    language: validateVoiceLanguage(overrides?.language || getEnv("VOICE_LANGUAGE") || DEFAULT_VOICE_LANGUAGE),
    sttProvider: overrides?.sttProvider || getEnv("VOICE_STT_PROVIDER") || DEFAULT_VOICE_STT_PROVIDER,
    sttBinaryPath: overrides?.sttBinaryPath || getEnv("VOICE_STT_BINARY_PATH") || DEFAULT_VOICE_STT_BINARY_PATH,
    sttModelPath: overrides?.sttModelPath || getEnv("VOICE_STT_MODEL_PATH") || DEFAULT_VOICE_STT_MODEL_PATH,
    sttBaseUrl: overrides?.sttBaseUrl || getEnv("VOICE_STT_BASE_URL") || DEFAULT_VOICE_STT_BASE_URL,
    sttTimeoutMs: positiveInteger(overrides?.sttTimeoutMs, getEnv("VOICE_STT_TIMEOUT_MS"), DEFAULT_VOICE_STT_TIMEOUT_MS),
    ttsProvider: overrides?.ttsProvider || getEnv("VOICE_TTS_PROVIDER") || DEFAULT_VOICE_TTS_PROVIDER,
    ttsBaseUrl: overrides?.ttsBaseUrl || getEnv("VOICE_TTS_BASE_URL") || DEFAULT_VOICE_TTS_BASE_URL,
    ttsModel: overrides?.ttsModel || getEnv("VOICE_TTS_MODEL") || DEFAULT_VOICE_TTS_MODEL,
    ttsTimeoutMs: positiveInteger(overrides?.ttsTimeoutMs, getEnv("VOICE_TTS_TIMEOUT_MS"), DEFAULT_VOICE_TTS_TIMEOUT_MS),
    piperBinaryPath: overrides?.piperBinaryPath || getEnv("PIPER_BINARY_PATH") || DEFAULT_PIPER_BINARY_PATH,
    piperVoice: overrides?.piperVoice || getEnv("PIPER_VOICE") || DEFAULT_PIPER_VOICE,
    piperSpeaker: optionalNonNegativeInteger(overrides?.piperSpeaker, getEnv("PIPER_SPEAKER")),
    supertonicAssetsDir: overrides?.supertonicAssetsDir || getEnv("SUPERTONIC_ASSETS_DIR") || DEFAULT_SUPERTONIC_ASSETS_DIR,
    supertonicVoice: overrides?.supertonicVoice || getEnv("SUPERTONIC_VOICE") || DEFAULT_SUPERTONIC_VOICE,
    ttsChunkMinChars: positiveInteger(overrides?.ttsChunkMinChars, getEnv("VOICE_TTS_CHUNK_MIN"), DEFAULT_VOICE_TTS_CHUNK_MIN),
    ttsChunkMaxChars: positiveInteger(overrides?.ttsChunkMaxChars, getEnv("VOICE_TTS_CHUNK_MAX"), DEFAULT_VOICE_TTS_CHUNK_MAX),
    sampleRate: positiveInteger(overrides?.sampleRate, getEnv("VOICE_SAMPLE_RATE"), DEFAULT_VOICE_SAMPLE_RATE),
    bargeIn: parseBoolean(overrides?.bargeIn, getEnv("VOICE_BARGE_IN"), DEFAULT_VOICE_BARGE_IN),
    debugTranscript: parseBoolean(
      overrides?.debugTranscript,
      getEnv("VOICE_DEBUG_TRANSCRIPT"),
      DEFAULT_VOICE_DEBUG_TRANSCRIPT
    ),
    promptsDir: overrides?.promptsDir || getEnv("PROMPTS_DIR") || DEFAULT_PROMPTS_DIR,
    vadThreshold: positiveNumber(overrides?.vadThreshold, getEnv("VOICE_VAD_THRESHOLD"), DEFAULT_VOICE_VAD_THRESHOLD),
    vadSpeechMs: positiveInteger(overrides?.vadSpeechMs, getEnv("VOICE_VAD_SPEECH_MS"), DEFAULT_VOICE_VAD_SPEECH_MS),
    vadSilenceMs: positiveInteger(overrides?.vadSilenceMs, getEnv("VOICE_VAD_SILENCE_MS"), DEFAULT_VOICE_VAD_SILENCE_MS),
    vadMinThreshold: positiveNumber(overrides?.vadMinThreshold, getEnv("VOICE_VAD_MIN_THRESHOLD"), DEFAULT_VOICE_VAD_MIN_THRESHOLD),
    bargeInThreshold: optionalPositiveNumber(overrides?.bargeInThreshold, getEnv("VOICE_BARGEIN_THRESHOLD")),
    bargeInSpeechMs: positiveInteger(overrides?.bargeInSpeechMs, getEnv("VOICE_BARGEIN_SPEECH_MS"), DEFAULT_VOICE_BARGEIN_SPEECH_MS),
  };
}

/**
 * Print the resolved config with the source of each value noted.
 * API key is masked (only last 4 chars shown).
 */
export function printConfig(config: AppConfig): void {
  const sources = resolveConfigSources(config);

  const maskedKey = config.provider === "ollama" ? "(not required)" : maskApiKey(config.apiKey);

  console.log("");
  console.log("  ┌─────────────────────────────────────────────┐");
  console.log("  │           llmtest — Configuration            │");
  console.log("  ├──────────────┬──────────────────────────────┤");
  console.log(
    `  │ Provider     │ ${pad(config.provider, 28)} │`
  );
  console.log(
    `  │   source     │ ${pad(sources.provider, 28)} │`
  );
  console.log("  ├──────────────┼──────────────────────────────┤");
  console.log(
    `  │ API Key      │ ${pad(maskedKey, 28)} │`
  );
  console.log(
    `  │   source     │ ${pad(sources.apiKey, 28)} │`
  );
  console.log("  ├──────────────┼──────────────────────────────┤");
  console.log(
    `  │ Model        │ ${pad(config.model, 28)} │`
  );
  console.log(
    `  │   source     │ ${pad(sources.model, 28)} │`
  );
  console.log("  ├──────────────┼──────────────────────────────┤");
  console.log(
    `  │ Log Level    │ ${pad(config.logLevel, 28)} │`
  );
  console.log(
    `  │   source     │ ${pad(sources.logLevel, 28)} │`
  );
  console.log("  └──────────────┴──────────────────────────────┘");
  console.log("");
}

/**
 * Mask an API key, showing only the last 4 characters.
 * Example: "sk-abc123xyz" → "••••••••xyz"
 */
function maskApiKey(key: string): string {
  if (key.length <= 4) {
    return "••••";
  }
  const visible = key.slice(-4);
  return "•".repeat(8) + visible;
}

/**
 * Determine the source of each resolved config value.
 */
function resolveConfigSources(config: AppConfig): ConfigSource {
  const providerSource = resolveSource("provider", config.provider, "LLMTEST_PROVIDER", DEFAULT_PROVIDER);
  const apiKeyEnvVar = config.provider === "github" ? "GITHUB_TOKEN" : "GOOGLE_API_KEY";
  const modelEnvVar = getModelEnvVarName(config.provider);
  const defaultModel = getDefaultModel(config.provider);
  const apiKeySource = config.provider === "ollama"
    ? "not required"
    : resolveSource("apiKey", config.apiKey, apiKeyEnvVar);
  const modelSource = resolveSource("model", config.model, modelEnvVar, defaultModel);
  const logLevelSource = resolveSource("logLevel", config.logLevel, "LLMTEST_LOG_LEVEL", DEFAULT_LOG_LEVEL);
  const ollamaBaseUrlSource = resolveSource(
    "ollamaBaseUrl",
    config.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    "OLLAMA_BASE_URL",
    DEFAULT_OLLAMA_BASE_URL
  );

  return {
    provider: providerSource,
    apiKey: apiKeySource,
    model: modelSource,
    logLevel: logLevelSource,
    ollamaBaseUrl: ollamaBaseUrlSource,
  };
}

function getModelEnvVarName(provider: AppConfig["provider"]): string {
  if (provider === "github") return "GITHUB_MODEL";
  if (provider === "ollama") return "OLLAMA_MODEL";
  return "GOOGLE_MODEL";
}

function getDefaultModel(provider: AppConfig["provider"]): string {
  if (provider === "github") return DEFAULT_MODEL_GITHUB;
  if (provider === "ollama") return DEFAULT_MODEL_OLLAMA;
  return DEFAULT_MODEL_GOOGLE;
}

/**
 * Determine the source label for a single config value.
 */
function resolveSource(
  _fieldName: string,
  value: string,
  envVarName: string,
  defaultValue?: string
): string {
  // If there's a matching env var, it likely came from env or .env file
  if (process.env[envVarName] && process.env[envVarName] === value) {
    // Check if it might be from a .env file
    if (fs.existsSync(LOCAL_ENV_PATH)) {
      const localContent = fs.readFileSync(LOCAL_ENV_PATH, "utf-8");
      if (localContent.includes(`${envVarName}=`)) {
        return "local .env file";
      }
    }
    if (fs.existsSync(GLOBAL_ENV_PATH)) {
      const globalContent = fs.readFileSync(GLOBAL_ENV_PATH, "utf-8");
      if (globalContent.includes(`${envVarName}=`)) {
        return "global ~/.llmtest/.env";
      }
    }
    return "environment variable";
  }

  if (defaultValue && value === defaultValue) {
    return "default";
  }

  return "CLI flag";
}

/**
 * Validate and normalize the log level string.
 */
function validateLogLevel(level: string): AppConfig["logLevel"] {
  const normalized = level.toLowerCase().trim();
  if (normalized === "silent" || normalized === "info" || normalized === "debug") {
    return normalized;
  }
  return DEFAULT_LOG_LEVEL;
}

function validateVoiceLanguage(language: string): VoiceLanguage {
  const normalized = language.toLowerCase().trim();
  if (normalized === "en" || normalized === "fr") {
    return normalized;
  }
  return DEFAULT_VOICE_LANGUAGE;
}

function parseBoolean(
  override: boolean | undefined,
  rawValue: string | undefined,
  defaultValue: boolean
): boolean {
  if (override !== undefined) {
    return override;
  }

  if (!rawValue) {
    return defaultValue;
  }

  const normalized = rawValue.toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function positiveInteger(
  override: number | undefined,
  rawValue: string | undefined,
  defaultValue: number
): number {
  if (override !== undefined && Number.isInteger(override) && override > 0) {
    return override;
  }

  const parsed = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return defaultValue;
}

function positiveNumber(
  override: number | undefined,
  rawValue: string | undefined,
  defaultValue: number
): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return override;
  }

  const parsed = rawValue ? Number.parseFloat(rawValue) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return defaultValue;
}

function optionalPositiveNumber(override: number | undefined, rawValue: string | undefined): number | undefined {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  if (!rawValue) return undefined;
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalNonNegativeInteger(override: number | undefined, rawValue: string | undefined): number | undefined {
  if (override !== undefined && Number.isInteger(override) && override >= 0) return override;
  if (!rawValue) return undefined;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Right-pad a string to the given length.
 */
function pad(str: string, len: number): string {
  if (str.length >= len) {
    return str.substring(0, len);
  }
  return str + " ".repeat(len - str.length);
}
