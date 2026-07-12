import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runConsolidation,
  parseVoiceSessionFile,
  episodeIdFor,
  SessionInput,
} from "../src/memory/consolidation";
import { parseMemoryAgentPlan } from "../src/memory/memoryAgent";
import {
  ensureMemoryLayout,
  readMemoryIndex,
  readConsolidationRegistry,
  listInboxNotes,
  appendInboxNote,
  upsertFactFile,
  archiveMemoryEntry,
  updateMemoryIndex,
} from "../src/memory/memoryStore";
import { ILLMProvider } from "../src/providers/ILLMProvider";
import { PromptResult } from "../src/types";

/** Minimal fake provider returning a fixed text for every prompt() call. */
function fakeProvider(responseText: string | (() => string)): ILLMProvider {
  const respond = typeof responseText === "function" ? responseText : () => responseText;
  const result = (): PromptResult => ({
    text: respond(),
    latencyMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    finishReason: "stop",
  });

  return {
    name: "fake",
    validate: async () => ({ valid: true }),
    prompt: async () => result(),
    chat: async () => {
      throw new Error("not used");
    },
    streamChat: async () => {
      throw new Error("not used");
    },
  };
}

/** Recursive snapshot of every file under a directory (path → content). */
function snapshotDir(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else {
        snapshot[path.relative(dir, full)] = fs.readFileSync(full, "utf-8");
      }
    }
  };
  walk(dir);
  return snapshot;
}

const VALID_PLAN = JSON.stringify({
  episode: {
    summary: "Alexy discussed his cat's diet.",
    decisions: ["Feed the cat twice a day."],
    openThreads: ["Choose a vet."],
    hook: "cat diet conversation",
  },
  factUpserts: [
    {
      id: "cat-named-miso",
      body: "Alexy has a cat named Miso.",
      hook: "has a cat named Miso",
    },
  ],
  archiveIds: [],
});

const SESSION: SessionInput = {
  sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
  channel: "voice",
  date: "2026-07-12",
  transcript: "User: retiens que mon chat s'appelle Miso\nAssistant: C'est noté !",
  messageCount: 2,
};

describe("memory consolidation", () => {
  let tempDir: string;
  const originalMemoryDir = process.env.LLMTEST_MEMORY_DIR;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmtest-consolidation-"));
    process.env.LLMTEST_MEMORY_DIR = tempDir;
  });

  afterEach(() => {
    if (originalMemoryDir === undefined) {
      delete process.env.LLMTEST_MEMORY_DIR;
    } else {
      process.env.LLMTEST_MEMORY_DIR = originalMemoryDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("applies a valid plan: episode, fact, index, inbox, registry", async () => {
    ensureMemoryLayout();
    appendInboxNote("retiens que mon chat s'appelle Miso", "test");

    const result = await runConsolidation({
      provider: fakeProvider(VALID_PLAN),
      sessions: [SESSION],
    });

    expect(result.failed).toEqual([]);
    expect(result.consolidated).toEqual([SESSION.sessionId]);
    expect(result.factsWritten).toEqual(["cat-named-miso"]);
    expect(result.inboxProcessed).toBe(1);

    const episodeId = episodeIdFor(SESSION.sessionId, SESSION.date);
    expect(episodeId).toBe("2026-07-12-abcd1234");

    const episodeFile = path.join(tempDir, "episodes", `${episodeId}.md`);
    const episodeContent = fs.readFileSync(episodeFile, "utf-8");
    expect(episodeContent).toContain("## Summary");
    expect(episodeContent).toContain("Alexy discussed his cat's diet.");
    expect(episodeContent).toContain("## Decisions");
    expect(episodeContent).toContain("## Open threads");
    expect(episodeContent).toContain(`session_id: ${SESSION.sessionId}`);

    const factFile = path.join(tempDir, "facts", "cat-named-miso.md");
    expect(fs.readFileSync(factFile, "utf-8")).toContain("Alexy has a cat named Miso.");

    const index = readMemoryIndex();
    expect(index).toContain("- [cat-named-miso](facts/cat-named-miso.md) — has a cat named Miso");
    expect(index).toContain(`- [${episodeId}](episodes/${episodeId}.md) — cat diet conversation`);

    // Inbox emptied by archiving, never deleting.
    expect(listInboxNotes()).toEqual([]);
    const archived = fs.readdirSync(path.join(tempDir, "archive"));
    expect(archived.some((name) => name.startsWith("inbox-"))).toBe(true);

    const registry = readConsolidationRegistry();
    expect(registry[SESSION.sessionId]?.messageCount).toBe(2);
  });

  it("is idempotent: a second run with the same input changes nothing", async () => {
    ensureMemoryLayout();
    const provider = fakeProvider(VALID_PLAN);

    await runConsolidation({ provider, sessions: [SESSION] });
    const before = snapshotDir(tempDir);

    const second = await runConsolidation({ provider, sessions: [SESSION] });
    expect(second.consolidated).toEqual([]);
    expect(second.skipped).toEqual([SESSION.sessionId]);
    expect(snapshotDir(tempDir)).toEqual(before);
  });

  it("re-consolidates a grown session and overwrites its episode without duplicating index lines", async () => {
    ensureMemoryLayout();
    await runConsolidation({ provider: fakeProvider(VALID_PLAN), sessions: [SESSION] });

    const grown = { ...SESSION, messageCount: 4 };
    const updatedPlan = JSON.stringify({
      episode: {
        summary: "Updated summary.",
        decisions: [],
        openThreads: [],
        hook: "updated hook",
      },
      factUpserts: [],
      archiveIds: [],
    });
    const result = await runConsolidation({ provider: fakeProvider(updatedPlan), sessions: [grown] });
    expect(result.consolidated).toEqual([SESSION.sessionId]);

    const episodeId = episodeIdFor(SESSION.sessionId, SESSION.date);
    const episodeContent = fs.readFileSync(
      path.join(tempDir, "episodes", `${episodeId}.md`),
      "utf-8"
    );
    expect(episodeContent).toContain("Updated summary.");
    expect(episodeContent).not.toContain("cat's diet");

    const indexLines = readMemoryIndex()
      .split("\n")
      .filter((line) => line.includes(`(episodes/${episodeId}.md)`));
    expect(indexLines).toHaveLength(1);
    expect(indexLines[0]).toContain("updated hook");

    expect(readConsolidationRegistry()[SESSION.sessionId]?.messageCount).toBe(4);
  });

  it("leaves every file byte-identical when the model output is malformed", async () => {
    ensureMemoryLayout();
    appendInboxNote("retiens que test", "test");
    upsertFactFile("existing-fact", "Alexy exists.", "test");
    updateMemoryIndex({ factEntries: [{ id: "existing-fact", hook: "exists" }] });

    const before = snapshotDir(tempDir);

    for (const bad of ["not json at all", '{"episode": null}', '{"episode": null, "factUpserts": [{"id": "BAD ID!", "body": "x", "hook": "y"}], "archiveIds": []}']) {
      const result = await runConsolidation({
        provider: fakeProvider(bad),
        sessions: [SESSION],
      });
      expect(result.failed).toHaveLength(1);
      expect(result.consolidated).toEqual([]);
      expect(snapshotDir(tempDir)).toEqual(before);
      expect(readConsolidationRegistry()[SESSION.sessionId]).toBeUndefined();
    }
  });

  it("archives facts named in archiveIds and ignores unknown ids", async () => {
    ensureMemoryLayout();
    upsertFactFile("old-preference", "Alexy used to prefer X.", "test");
    updateMemoryIndex({ factEntries: [{ id: "old-preference", hook: "prefers X" }] });

    const plan = JSON.stringify({
      episode: null,
      factUpserts: [],
      archiveIds: ["old-preference", "never-existed"],
    });
    const result = await runConsolidation({
      provider: fakeProvider(plan),
      sessions: [SESSION],
    });

    expect(result.archivedIds).toEqual(["old-preference"]);
    expect(fs.existsSync(path.join(tempDir, "facts", "old-preference.md"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "archive", "old-preference.md"))).toBe(true);
    expect(readMemoryIndex()).not.toContain("old-preference");
  });

  it("marks empty sessions consolidated without calling the LLM", async () => {
    ensureMemoryLayout();
    let called = 0;
    const provider = fakeProvider(() => {
      called += 1;
      return VALID_PLAN;
    });

    const empty: SessionInput = { ...SESSION, sessionId: "empty-session", transcript: "", messageCount: 0 };
    const result = await runConsolidation({ provider, sessions: [empty] });

    expect(called).toBe(0);
    expect(result.skipped).toEqual(["empty-session"]);
    expect(readConsolidationRegistry()["empty-session"]).toBeDefined();
  });

  it("runs inbox-only consolidation when no session is pending", async () => {
    ensureMemoryLayout();
    appendInboxNote("remember that Alexy's birthday is March 3rd", "test");

    const plan = JSON.stringify({
      episode: null,
      factUpserts: [
        { id: "birthday-march-3", body: "Alexy's birthday is March 3rd.", hook: "birthday March 3rd" },
      ],
      archiveIds: [],
    });
    const result = await runConsolidation({ provider: fakeProvider(plan), sessions: [] });

    expect(result.factsWritten).toEqual(["birthday-march-3"]);
    expect(result.inboxProcessed).toBe(1);
    expect(listInboxNotes()).toEqual([]);
    expect(fs.existsSync(path.join(tempDir, "facts", "birthday-march-3.md"))).toBe(true);
  });

  it("does nothing at all when there is nothing pending", async () => {
    ensureMemoryLayout();
    let called = 0;
    const provider = fakeProvider(() => {
      called += 1;
      return VALID_PLAN;
    });

    const result = await runConsolidation({ provider, sessions: [] });
    expect(called).toBe(0);
    expect(result.consolidated).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("skips excluded (live) sessions", async () => {
    ensureMemoryLayout();
    const result = await runConsolidation({
      provider: fakeProvider(VALID_PLAN),
      sessions: [SESSION],
      excludeSessionIds: [SESSION.sessionId],
    });

    expect(result.consolidated).toEqual([]);
    expect(readConsolidationRegistry()[SESSION.sessionId]).toBeUndefined();
  });

  it("fact updates preserve created date and unknown frontmatter keys", async () => {
    ensureMemoryLayout();
    const factPath = path.join(tempDir, "facts", "cat-named-miso.md");
    fs.writeFileSync(
      factPath,
      [
        "---",
        "id: cat-named-miso",
        "type: fact",
        "created: 2026-01-01",
        "updated: 2026-01-01",
        "source: old session",
        "custom_key: hand-edited value",
        "---",
        "",
        "Alexy has a cat.",
        "",
      ].join("\n"),
      "utf-8"
    );

    await runConsolidation({ provider: fakeProvider(VALID_PLAN), sessions: [SESSION] });

    const updated = fs.readFileSync(factPath, "utf-8");
    expect(updated).toContain("created: 2026-01-01");
    expect(updated).toContain("custom_key: hand-edited value");
    expect(updated).toContain("Alexy has a cat named Miso.");
    expect(updated).not.toContain("Alexy has a cat.\n");
  });
});

describe("parseVoiceSessionFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmtest-voicelog-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rebuilds the conversation from final events only", () => {
    const filePath = path.join(tempDir, "12345-abc.jsonl");
    const events = [
      { sessionId: "voice-1", timestamp: 1752278400000, turnIndex: 0, type: "session_start", data: {} },
      { sessionId: "voice-1", timestamp: 1752278401000, turnIndex: 1, type: "partial_transcript", text: "bonj" },
      { sessionId: "voice-1", timestamp: 1752278402000, turnIndex: 1, type: "final_transcript", text: "bonjour" },
      { sessionId: "voice-1", timestamp: 1752278403000, turnIndex: 1, type: "assistant_chunk", text: "Sal" },
      { sessionId: "voice-1", timestamp: 1752278404000, turnIndex: 1, type: "assistant_final", text: "Salut Alexy !" },
      { sessionId: "voice-1", timestamp: 1752278405000, turnIndex: 2, type: "memory_note", text: "retiens que X" },
    ];
    fs.writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n", "utf-8");

    const parsed = parseVoiceSessionFile(filePath);
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe("voice-1");
    expect(parsed?.channel).toBe("voice");
    expect(parsed?.messageCount).toBe(2);
    expect(parsed?.transcript).toContain("User: bonjour");
    expect(parsed?.transcript).toContain("Assistant: Salut Alexy !");
    expect(parsed?.transcript).toContain("[Remember request already captured in inbox: retiens que X]");
    expect(parsed?.transcript).not.toContain("bonj\n");
    expect(parsed?.date).toBe(new Date(1752278400000).toISOString().slice(0, 10));
  });

  it("returns null for unreadable or id-less files", () => {
    expect(parseVoiceSessionFile(path.join(tempDir, "missing.jsonl"))).toBeNull();

    const noId = path.join(tempDir, "noid.jsonl");
    fs.writeFileSync(noId, "not json\n{}\n", "utf-8");
    expect(parseVoiceSessionFile(noId)).toBeNull();
  });
});

describe("parseMemoryAgentPlan", () => {
  it("accepts a fenced JSON plan", () => {
    const result = parseMemoryAgentPlan("```json\n" + VALID_PLAN + "\n```");
    expect(result.plan).not.toBeNull();
    expect(result.plan?.factUpserts[0].id).toBe("cat-named-miso");
  });

  it("rejects oversized plans wholesale", () => {
    const oversized = JSON.stringify({
      episode: null,
      factUpserts: Array.from({ length: 21 }, (_, i) => ({
        id: `fact-${i}`,
        body: "x",
        hook: "y",
      })),
      archiveIds: [],
    });
    const result = parseMemoryAgentPlan(oversized);
    expect(result.plan).toBeNull();
    expect(result.error).toContain("validation");
  });

  it("rejects invalid fact ids", () => {
    const bad = JSON.stringify({
      episode: null,
      factUpserts: [{ id: "../escape", body: "x", hook: "y" }],
      archiveIds: [],
    });
    expect(parseMemoryAgentPlan(bad).plan).toBeNull();
  });
});

describe("archiveMemoryEntry (memory forget)", () => {
  let tempDir: string;
  const originalMemoryDir = process.env.LLMTEST_MEMORY_DIR;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmtest-forget-"));
    process.env.LLMTEST_MEMORY_DIR = tempDir;
  });

  afterEach(() => {
    if (originalMemoryDir === undefined) {
      delete process.env.LLMTEST_MEMORY_DIR;
    } else {
      process.env.LLMTEST_MEMORY_DIR = originalMemoryDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("moves a fact to archive/ and removes its index line", () => {
    ensureMemoryLayout();
    upsertFactFile("to-forget", "Some fact.", "test");
    updateMemoryIndex({ factEntries: [{ id: "to-forget", hook: "some fact" }] });
    expect(readMemoryIndex()).toContain("to-forget");

    const archived = archiveMemoryEntry("to-forget");
    expect(archived).not.toBeNull();
    expect(fs.existsSync(path.join(tempDir, "facts", "to-forget.md"))).toBe(false);
    expect(fs.existsSync(archived as string)).toBe(true);
    expect(readMemoryIndex()).not.toContain("to-forget");
  });

  it("returns null for unknown ids and traversal attempts", () => {
    ensureMemoryLayout();
    expect(archiveMemoryEntry("unknown-id")).toBeNull();
    expect(archiveMemoryEntry("../MEMORY")).toBeNull();
  });
});
