/**
 * Shared TypeScript types for the llmtest CLI tool.
 * All types are exported for use across the application.
 */

// ── Core / Base Types ─────────────────────────────────────────────

/** A single message in a chat conversation. */
export interface Message {
  role: "user" | "model";
  content: string;
  timestamp: number;
}

/** Input parameters for a single prompt request. */
export interface PromptInput {
  prompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  /** E7: Optional path to an image file for multi-modal prompts. */
  image?: string;
  /** E4: Request JSON-formatted output from the model. */
  responseFormat?: "json";
  /** E4: JSON Schema object to enforce on the response. */
  responseSchema?: Record<string, unknown>;
}

/** Result of a single prompt request. */
export interface PromptResult {
  text: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  finishReason: string;
}

/** Result of a chat turn. */
export interface ChatResult {
  message: Message;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Result of an API key validation check. */
export interface ValidationResult {
  valid: boolean;
  errorCode?: string;
  errorMessage?: string;
  modelAccess?: string[];
}

// ── E6: LLM-as-Judge Types ────────────────────────────────────────

/** Criteria and threshold for LLM-as-Judge evaluation. */
export interface JudgeCriteria {
  criteria: string;
  minScore: number;
  /** Override the model used for judging. */
  model?: string;
}

/** Result produced by the LLM judge. */
export interface JudgeResult {
  score: number;
  reason: string;
  passed: boolean;
}

// ── Base Test Types (extended for E4 and E6) ─────────────────────

/** A single test case within a test suite. */
export interface TestCase {
  id: string;
  prompt: string;
  systemPrompt?: string;
  /** E7: Optional path to an image file (resolved relative to the suite file). */
  image?: string;
  /** E4: Request JSON-formatted output. */
  responseFormat?: "json";
  /** E4: JSON Schema to validate the response against. */
  responseSchema?: Record<string, unknown>;
  expect?: {
    keywords?: string[];
    maxLatencyMs?: number;
    /** E6: LLM-as-Judge criteria for scoring this test case. */
    judge?: JudgeCriteria;
    /** E4: JSONPath assertions against the parsed JSON response. */
    jsonPath?: Array<{ path: string; equals: unknown }>;
  };
}

/** A collection of test cases to run as a benchmark suite. */
export interface TestSuite {
  name?: string;
  model?: string;
  defaults?: Partial<PromptInput>;
  tests: TestCase[];
}

/** Result of executing a single test case. */
export interface TestCaseResult {
  id: string;
  passed: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  matchedKeywords: string[];
  missedKeywords: string[];
  error?: string;
  /** E6: Judge result, present when the test case has a judge block. */
  judgeResult?: JudgeResult;
}

/** Resolved application configuration. */
export interface AppConfig {
  apiKey: string;
  model: string;
  logLevel: "silent" | "info" | "debug";
  /** Which LLM provider to use. Defaults to "google". */
  provider: "google" | "github" | "ollama";
  /** Base URL for a local Ollama server, used only when provider is "ollama". */
  ollamaBaseUrl?: string;
  /** Voice conversation settings used by the audio/STT/TTS pipeline. */
  voice: VoiceConfig;
}

/** Initial supported voice session languages. */
export type VoiceLanguage = "fr" | "en";

/** Resolved configuration for local-first voice conversation features. */
export interface VoiceConfig {
  language: VoiceLanguage;
  sttProvider: string;
  sttBinaryPath: string;
  sttModelPath: string;
  sttBaseUrl: string;
  sttTimeoutMs: number;
  ttsProvider: string;
  ttsBaseUrl: string;
  ttsModel: string;
  ttsTimeoutMs: number;
  /** Piper executable and voice selection (CPU process integration). */
  piperBinaryPath?: string;
  piperVoice?: string;
  piperSpeaker?: number;
  /** Supertonic model assets and style preset (CPU ONNX integration). */
  supertonicAssetsDir?: string;
  supertonicVoice?: string;
  /** Streaming TTS text chunking controls. */
  ttsChunkMinChars?: number;
  ttsChunkMaxChars?: number;
  sampleRate: number;
  bargeIn: boolean;
  debugTranscript: boolean;
  promptsDir: string;
  vadThreshold: number;
  vadSpeechMs: number;
  vadSilenceMs: number;
  /** Lower bound for the adaptive VAD threshold (tune down for very quiet capture devices). */
  vadMinThreshold: number;
  /**
   * Fixed RMS threshold for barge-in detection while the assistant is speaking.
   * When unset, barge-in uses the adaptive VAD with stricter guards instead.
   */
  bargeInThreshold?: number;
  /** Continuous speech required to trigger a barge-in (longer than vadSpeechMs to reject TTS bleed). */
  bargeInSpeechMs: number;
}

/** A persisted chat session. */
export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messages: Message[];
}

/** One JSONL event written by voice-chat for debugging and latency review. */
export interface VoiceTranscriptEvent {
  sessionId: string;
  timestamp: number;
  turnIndex: number;
  type:
    | "session_start"
    | "state"
    | "command"
    | "partial_transcript"
    | "final_transcript"
    | "assistant_chunk"
    | "assistant_final"
    | "tool_activity"
    | "interrupted"
    | "metrics"
    | "vad"
    | "memory_note"
    | "error"
    | "session_end";
  text?: string;
  data?: Record<string, unknown>;
}

/** Metadata for a persisted voice-chat transcript log. */
export interface VoiceTranscriptLog {
  id: string;
  createdAt: number;
  model: string;
  language: VoiceLanguage;
  filePath: string;
}

// ── E1: Agentic / Tool-Use Testing Types ─────────────────────────

/** Expected tool call (name required; params is a partial subset match). */
export interface ToolCallExpectation {
  name: string;
  params?: Record<string, unknown>;
}

/** File content assertion: the file at `path` must contain `contains`. */
export interface FileAssertion {
  path: string;
  contains: string;
}

/** A single agentic test case. */
export interface AgentTestCase {
  id: string;
  prompt: string;
  systemPrompt?: string;
  expect?: {
    toolCalls?: ToolCallExpectation[];
    fileAssertions?: FileAssertion[];
    keywords?: string[];
    maxSteps?: number;
  };
}

/** A suite of agentic test cases. */
export interface AgentTestSuite {
  name?: string;
  type: "agentic";
  model?: string;
  tools: string[];
  sandbox?: string;
  defaults?: { maxSteps?: number };
  tests: AgentTestCase[];
}

/** A recorded tool invocation made during an agent loop step. */
export interface ToolCallRecord {
  name: string;
  params: Record<string, unknown>;
  result: unknown;
  stepIndex: number;
}

/** Result of a single agent test case execution. */
export interface AgentTestCaseResult {
  id: string;
  passed: boolean;
  steps: number;
  toolCallsMade: ToolCallRecord[];
  matchedToolCalls: string[];
  missedToolCalls: string[];
  fileAssertionResults: { path: string; passed: boolean }[];
  matchedKeywords: string[];
  missedKeywords: string[];
  finalAnswer: string;
  error?: string;
}

/** A single step produced by the agent loop. */
export interface AgentStepResult {
  type: "tool_call" | "final_answer";
  toolName?: string;
  toolParams?: Record<string, unknown>;
  text?: string;
  inputTokens: number;
  outputTokens: number;
}

// ── E2: RAG Testing Types ─────────────────────────────────────────

/** A document to inject as RAG context. */
export interface RagDocument {
  source: "file" | "inline";
  path?: string;
  content?: string;
}

/** Faithfulness score returned by the RAG faithfulness judge. */
export interface FaithfulnessScore {
  score: number;
  reason: string;
  hallucinated: boolean;
}

/** A single RAG test case. */
export interface RagTestCase {
  id: string;
  question: string;
  documents: RagDocument[];
  systemPrompt?: string;
  expect?: {
    keywords?: string[];
    quotes?: string[];
    faithfulness?: boolean;
    noHallucination?: boolean;
    faithfulnessThreshold?: number;
  };
}

/** A suite of RAG test cases. */
export interface RagTestSuite {
  name?: string;
  type: "rag";
  model?: string;
  tests: RagTestCase[];
}

/** Result of a single RAG test case execution. */
export interface RagTestCaseResult {
  id: string;
  passed: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  matchedKeywords: string[];
  missedKeywords: string[];
  matchedQuotes: string[];
  missedQuotes: string[];
  faithfulness?: FaithfulnessScore;
  error?: string;
}

// ── E5: Multi-turn Conversation Testing Types ─────────────────────

/** A single user turn in a scripted conversation test. */
export interface ConversationTurn {
  user: string;
  expect?: {
    keywords?: string[];
    maxLatencyMs?: number;
  };
}

/** Result of a single conversation turn. */
export interface ConversationTurnResult {
  turnIndex: number;
  passed: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  matchedKeywords: string[];
  missedKeywords: string[];
  response: string;
}

/** A single scripted multi-turn conversation test case. */
export interface ConversationTestCase {
  id: string;
  systemPrompt?: string;
  turns: ConversationTurn[];
}

/** A suite of conversation test cases. */
export interface ConversationTestSuite {
  name?: string;
  type: "conversation";
  model?: string;
  defaults?: Partial<PromptInput>;
  tests: ConversationTestCase[];
}

/** Result of a single conversation test case execution. */
export interface ConversationTestCaseResult {
  id: string;
  passed: boolean;
  turns: ConversationTurnResult[];
  error?: string;
}

// ── E8: Agent Chat Session Types ──────────────────────────────────

/** A persisted agent chat session (tool-use + RAG aware). */
export interface AgentSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  messages: Message[];
  tools: string[];
  docPaths: string[];
}
