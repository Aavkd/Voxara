/**
 * Session Manager — persist and resume chat sessions across CLI invocations.
 *
 * Session file location: ~/.llmtest/session.json
 * Agent session file location: ~/.llmtest/agent-session.json
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as crypto from "crypto";
import { Session, AgentSession, VoiceLanguage, VoiceTranscriptEvent, VoiceTranscriptLog } from "../types";

const SESSION_DIR = path.join(os.homedir(), ".llmtest");
const SESSION_FILE = path.join(SESSION_DIR, "session.json");
const AGENT_SESSION_FILE = path.join(SESSION_DIR, "agent-session.json");
const VOICE_SESSION_DIR = path.join(SESSION_DIR, "voice-sessions");

/**
 * Save a session to disk.
 * Creates ~/.llmtest/ directory if it doesn't exist.
 */
export function saveSession(session: Session): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  session.updatedAt = Date.now();

  const data = JSON.stringify(session, null, 2);
  fs.writeFileSync(SESSION_FILE, data, "utf-8");
}

/**
 * Load a session from disk.
 * Returns null if the file doesn't exist or contains corrupt JSON.
 */
export function loadSession(): Session | null {
  if (!fs.existsSync(SESSION_FILE)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Session;

    // Basic shape validation
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.updatedAt !== "number" ||
      typeof parsed.model !== "string" ||
      !Array.isArray(parsed.messages)
    ) {
      return null;
    }

    return parsed;
  } catch {
    // Corrupt JSON or read error — return null, never throw
    return null;
  }
}

/**
 * Delete the session file from disk.
 */
export function clearSession(): void {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
  }
}

/**
 * Create a new session object with a UUID id and empty messages.
 */
export function createSession(model: string): Session {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model,
    messages: [],
  };
}

export function createVoiceTranscriptLog(model: string, language: VoiceLanguage): VoiceTranscriptLog {
  ensureDir(VOICE_SESSION_DIR);

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const filePath = path.join(VOICE_SESSION_DIR, `${createdAt}-${id}.jsonl`);
  const log: VoiceTranscriptLog = {
    id,
    createdAt,
    model,
    language,
    filePath,
  };

  appendVoiceTranscriptEvent(log, {
    sessionId: id,
    timestamp: createdAt,
    turnIndex: 0,
    type: "session_start",
    data: { model, language },
  });

  return log;
}

export function appendVoiceTranscriptEvent(
  log: VoiceTranscriptLog,
  event: Omit<VoiceTranscriptEvent, "sessionId" | "timestamp"> & {
    sessionId?: string;
    timestamp?: number;
  }
): void {
  ensureDir(path.dirname(log.filePath));

  const normalized: VoiceTranscriptEvent = {
    sessionId: event.sessionId || log.id,
    timestamp: event.timestamp || Date.now(),
    turnIndex: event.turnIndex,
    type: event.type,
    text: event.text,
    data: event.data,
  };

  fs.appendFileSync(log.filePath, `${JSON.stringify(normalized)}\n`, "utf-8");
}

// ── Agent Session Functions ───────────────────────────────────────

/**
 * Save an agent session to disk.
 * Creates ~/.llmtest/ directory if it doesn't exist.
 */
export function saveAgentSession(session: AgentSession): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  session.updatedAt = Date.now();

  const data = JSON.stringify(session, null, 2);
  fs.writeFileSync(AGENT_SESSION_FILE, data, "utf-8");
}

/**
 * Load an agent session from disk.
 * Returns null if the file doesn't exist or contains corrupt JSON.
 */
export function loadAgentSession(): AgentSession | null {
  if (!fs.existsSync(AGENT_SESSION_FILE)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(AGENT_SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw) as AgentSession;

    // Basic shape validation
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.updatedAt !== "number" ||
      typeof parsed.model !== "string" ||
      !Array.isArray(parsed.messages) ||
      !Array.isArray(parsed.tools) ||
      !Array.isArray(parsed.docPaths)
    ) {
      return null;
    }

    return parsed;
  } catch {
    // Corrupt JSON or read error — return null, never throw
    return null;
  }
}

/**
 * Create a new agent session object with a UUID id and empty messages.
 */
export function createAgentSession(
  model: string,
  tools: string[],
  docPaths: string[]
): AgentSession {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model,
    messages: [],
    tools,
    docPaths,
  };
}

/**
 * Delete the agent session file from disk.
 */
export function clearAgentSession(): void {
  if (fs.existsSync(AGENT_SESSION_FILE)) {
    fs.unlinkSync(AGENT_SESSION_FILE);
  }
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
