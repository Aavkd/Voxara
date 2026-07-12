/**
 * Phase M3 — memory hygiene (spec §8.3).
 *
 * Covers the acceptance criteria: duplicate merges, contradiction resolution
 * (newest wins, dated archive names), episode compaction into quarterly
 * digests, index budget enforcement, idempotency, and the never-hard-delete
 * guarantee (archive contains every displaced file).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runConsolidation, SessionInput } from "../src/memory/consolidation";
import { parseHygienePlan } from "../src/memory/memoryAgent";
import {
  MEMORY_INDEX_MAX_LINES,
  compactOldEpisodes,
  enforceMemoryIndexBudget,
  ensureMemoryLayout,
  listFactDetails,
  readMemoryIndex,
  updateMemoryIndex,
  upsertFactFile,
  writeEpisodeFile,
} from "../src/memory/memoryStore";
import { ILLMProvider } from "../src/providers/ILLMProvider";
import { PromptInput, PromptResult } from "../src/types";

/** Fake provider that records every prompt and answers per call index. */
function fakeProvider(
  respond: (prompt: string, callIndex: number) => string
): ILLMProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "fake",
    prompts,
    validate: async () => ({ valid: true }),
    prompt: async (input: PromptInput): Promise<PromptResult> => {
      prompts.push(input.prompt);
      return {
        text: respond(input.prompt, prompts.length - 1),
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        finishReason: "stop",
      };
    },
    chat: async () => {
      throw new Error("not used");
    },
    streamChat: async () => {
      throw new Error("not used");
    },
  };
}

const EMPTY_HYGIENE_PLAN = JSON.stringify({ merges: [], contradictions: [] });

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

function writeFactWithDates(
  tempDir: string,
  id: string,
  body: string,
  created: string,
  updated: string
): void {
  fs.writeFileSync(
    path.join(tempDir, "facts", `${id}.md`),
    [
      "---",
      `id: ${id}`,
      "type: fact",
      `created: ${created}`,
      `updated: ${updated}`,
      "source: test",
      "---",
      "",
      body,
      "",
    ].join("\n"),
    "utf-8"
  );
}

describe("memory hygiene", () => {
  let tempDir: string;
  const originalMemoryDir = process.env.LLMTEST_MEMORY_DIR;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmtest-hygiene-"));
    process.env.LLMTEST_MEMORY_DIR = tempDir;
    ensureMemoryLayout();
  });

  afterEach(() => {
    if (originalMemoryDir === undefined) {
      delete process.env.LLMTEST_MEMORY_DIR;
    } else {
      process.env.LLMTEST_MEMORY_DIR = originalMemoryDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("merges duplicate facts on a deep run: keepId absorbs, absorbed ids archived", async () => {
    upsertFactFile("cat-name", "Alexy has a cat named Miso.", "test");
    upsertFactFile("cat-called-miso", "The user's cat is called Miso and is 3 years old.", "test");
    updateMemoryIndex({
      factEntries: [
        { id: "cat-name", hook: "has a cat named Miso" },
        { id: "cat-called-miso", hook: "cat Miso, 3 years old" },
      ],
    });

    const plan = JSON.stringify({
      merges: [
        {
          keepId: "cat-name",
          absorbIds: ["cat-called-miso", "never-existed"],
          body: "Alexy has a cat named Miso, 3 years old.",
          hook: "cat Miso, 3 years old",
        },
      ],
      contradictions: [],
    });
    const result = await runConsolidation({
      provider: fakeProvider(() => plan),
      sessions: [],
      deep: true,
    });

    expect(result.hygiene.errors).toEqual([]);
    expect(result.hygiene.rewrittenFactIds).toEqual(["cat-name"]);
    expect(result.hygiene.mergedFactIds).toEqual(["cat-called-miso"]);

    const kept = fs.readFileSync(path.join(tempDir, "facts", "cat-name.md"), "utf-8");
    expect(kept).toContain("Alexy has a cat named Miso, 3 years old.");
    expect(fs.existsSync(path.join(tempDir, "facts", "cat-called-miso.md"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "archive", "cat-called-miso.md"))).toBe(true);

    const index = readMemoryIndex();
    expect(index).toContain("- [cat-name](facts/cat-name.md) — cat Miso, 3 years old");
    expect(index).not.toContain("cat-called-miso");
  });

  it("resolves contradictions in code: newest updated wins, loser archived with dated filename", async () => {
    writeFactWithDates(tempDir, "likes-long", "Alexy prefers long answers.", "2026-01-01", "2026-01-01");
    writeFactWithDates(tempDir, "likes-short", "Alexy prefers short answers.", "2026-03-01", "2026-06-01");
    updateMemoryIndex({
      factEntries: [
        { id: "likes-long", hook: "prefers long answers" },
        { id: "likes-short", hook: "prefers short answers" },
      ],
    });

    const plan = JSON.stringify({
      merges: [],
      contradictions: [{ ids: ["likes-long", "likes-short"] }],
    });
    const result = await runConsolidation({
      provider: fakeProvider(() => plan),
      sessions: [],
      deep: true,
    });

    expect(result.hygiene.contradictionsResolved).toEqual(["likes-long"]);
    // Winner untouched, loser archived under a dated name.
    expect(fs.existsSync(path.join(tempDir, "facts", "likes-short.md"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "facts", "likes-long.md"))).toBe(false);
    const today = new Date().toISOString().slice(0, 10);
    expect(fs.existsSync(path.join(tempDir, "archive", `likes-long-${today}.md`))).toBe(true);
    expect(readMemoryIndex()).not.toContain("likes-long");
    expect(readMemoryIndex()).toContain("likes-short");
  });

  it("compacts old episodes into quarterly digests and keeps the index within budget", async () => {
    // 100 fake old episodes spread over two quarters, all indexed.
    for (let i = 0; i < 100; i += 1) {
      const month = i < 50 ? "01" : "04";
      const day = String((i % 27) + 1).padStart(2, "0");
      const id = `2025-${month}-${day}-episode${i}`;
      writeEpisodeFile(id, {
        sessionId: `session-${i}`,
        date: `2025-${month}-${day}`,
        source: "test",
        summary: `Old conversation number ${i}.`,
        decisions: [],
        openThreads: [],
      });
      updateMemoryIndex({ episodeEntries: [{ id, hook: `old episode ${i}` }] });
    }
    expect(readMemoryIndex().split("\n").length).toBeGreaterThan(MEMORY_INDEX_MAX_LINES);

    const before = snapshotDir(tempDir);
    const result = await runConsolidation({
      provider: fakeProvider(() => EMPTY_HYGIENE_PLAN),
      sessions: [],
      deep: true,
    });

    expect(result.hygiene.episodesCompacted).toHaveLength(100);
    expect(fs.existsSync(path.join(tempDir, "episodes", "compacted-2025-q1.md"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "episodes", "compacted-2025-q2.md"))).toBe(true);

    const digest = fs.readFileSync(path.join(tempDir, "episodes", "compacted-2025-q1.md"), "utf-8");
    expect(digest).toContain("Old conversation number 0.");
    expect(digest).toContain("(2025-01-01-episode0)");

    // Index within budget, digests indexed, plain old episodes gone.
    const index = readMemoryIndex();
    expect(index.split("\n").length).toBeLessThanOrEqual(MEMORY_INDEX_MAX_LINES);
    expect(index).toContain("compacted-2025-q1");
    expect(index).not.toContain("episode17");

    // Nothing hard-deleted: every displaced episode file is in archive/.
    const archived = fs.readdirSync(path.join(tempDir, "archive"));
    for (const name of Object.keys(before).filter((p) => p.startsWith("episodes"))) {
      expect(archived).toContain(path.basename(name));
    }

    // Idempotent: a second deep run changes nothing.
    const snapshot = snapshotDir(tempDir);
    await runConsolidation({
      provider: fakeProvider(() => EMPTY_HYGIENE_PLAN),
      sessions: [],
      deep: true,
    });
    expect(snapshotDir(tempDir)).toEqual(snapshot);
  });

  it("drops the oldest episode index lines when young episodes overflow the budget", () => {
    for (let i = 0; i < 90; i += 1) {
      updateMemoryIndex({
        episodeEntries: [{ id: `2026-07-0${(i % 9) + 1}-ep${i}`, hook: `episode ${i}` }],
      });
    }
    expect(readMemoryIndex().split("\n").length).toBeGreaterThan(MEMORY_INDEX_MAX_LINES);

    const result = enforceMemoryIndexBudget();
    expect(result.overBudget).toBe(false);
    expect(result.droppedEpisodeIds.length).toBeGreaterThan(0);
    // Oldest (bottom-most) lines dropped first: the first-inserted episode is gone.
    const index = readMemoryIndex();
    expect(index.split("\n").length).toBeLessThanOrEqual(MEMORY_INDEX_MAX_LINES);
    expect(index).not.toContain("— episode 0");
    expect(index).toContain(`— episode 89`);
    // Files themselves are untouched — only index lines dropped.
  });

  it("runs an aggressive merge pass when fact lines alone exceed the budget", async () => {
    for (let i = 0; i < 90; i += 1) {
      upsertFactFile(`fact-${i}`, `Fact number ${i}.`, "test");
      updateMemoryIndex({ factEntries: [{ id: `fact-${i}`, hook: `fact ${i}` }] });
    }

    const mergeAll = JSON.stringify({
      merges: Array.from({ length: 20 }, (_, i) => ({
        keepId: `fact-${i}`,
        absorbIds: [`fact-${i + 20}`, `fact-${i + 40}`, `fact-${i + 60}`],
        body: `Merged fact ${i}.`,
        hook: `merged fact ${i}`,
      })),
      contradictions: [],
    });
    const provider = fakeProvider((_prompt, call) =>
      call === 0 ? EMPTY_HYGIENE_PLAN : mergeAll
    );

    const result = await runConsolidation({ provider, sessions: [], deep: true });

    // First pass returned nothing; the over-budget pass got the aggressive note.
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[0]).not.toContain("over its 80-line budget");
    expect(provider.prompts[1]).toContain("over its 80-line budget");
    expect(result.hygiene.mergedFactIds).toHaveLength(60);
    expect(readMemoryIndex().split("\n").length).toBeLessThanOrEqual(MEMORY_INDEX_MAX_LINES);
    expect(result.hygiene.errors).toEqual([]);
  });

  it("leaves facts byte-identical when the hygiene plan is malformed", async () => {
    upsertFactFile("fact-a", "Fact A.", "test");
    upsertFactFile("fact-b", "Fact B.", "test");
    updateMemoryIndex({
      factEntries: [
        { id: "fact-a", hook: "fact a" },
        { id: "fact-b", hook: "fact b" },
      ],
    });
    const before = snapshotDir(tempDir);

    for (const bad of [
      "not json",
      '{"merges": []}',
      // Well-formed JSON but empty absorbIds violates the schema's minItems.
      '{"merges": [{"keepId": "fact-a", "absorbIds": [], "body": "x", "hook": "y"}], "contradictions": []}',
    ]) {
      const result = await runConsolidation({
        provider: fakeProvider(() => bad),
        sessions: [],
        deep: true,
      });
      expect(result.hygiene.errors.length).toBeGreaterThan(0);
      expect(snapshotDir(tempDir)).toEqual(before);
    }
  });

  it("skips hygiene plan entries that reference unknown or duplicate ids", async () => {
    upsertFactFile("fact-a", "Fact A.", "test");
    upsertFactFile("fact-b", "Fact B.", "test");

    const plan = JSON.stringify({
      merges: [
        { keepId: "ghost", absorbIds: ["fact-a"], body: "x", hook: "y" },
        { keepId: "fact-a", absorbIds: ["fact-a"], body: "x", hook: "y" },
      ],
      contradictions: [{ ids: ["fact-a", "ghost"] }, { ids: ["fact-b", "fact-b"] }],
    });
    const result = await runConsolidation({
      provider: fakeProvider(() => plan),
      sessions: [],
      deep: true,
    });

    expect(result.hygiene.mergedFactIds).toEqual([]);
    expect(result.hygiene.rewrittenFactIds).toEqual([]);
    expect(result.hygiene.contradictionsResolved).toEqual([]);
    expect(fs.existsSync(path.join(tempDir, "facts", "fact-a.md"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "facts", "fact-b.md"))).toBe(true);
  });

  it("runs the agent pass after a normal consolidation that wrote facts", async () => {
    upsertFactFile("existing-one", "Fact one.", "test");
    upsertFactFile("existing-two", "Fact two.", "test");

    const session: SessionInput = {
      sessionId: "session-hygiene-1",
      channel: "text chat",
      date: "2026-07-12",
      transcript: "User: retiens que je préfère le thé\nAssistant: C'est noté !",
      messageCount: 2,
    };
    const consolidationPlan = JSON.stringify({
      episode: null,
      factUpserts: [{ id: "prefers-tea", body: "Alexy prefers tea.", hook: "prefers tea" }],
      archiveIds: [],
    });
    const provider = fakeProvider((_prompt, call) =>
      call === 0 ? consolidationPlan : EMPTY_HYGIENE_PLAN
    );

    const result = await runConsolidation({ provider, sessions: [session] });

    expect(result.factsWritten).toEqual(["prefers-tea"]);
    // Second call is the hygiene pass with full fact bodies.
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]).toContain("--- fact: prefers-tea");
    expect(provider.prompts[1]).toContain("Alexy prefers tea.");
    expect(result.hygiene.errors).toEqual([]);
  });

  it("skips the agent pass on normal runs that changed nothing", async () => {
    upsertFactFile("existing-one", "Fact one.", "test");
    upsertFactFile("existing-two", "Fact two.", "test");

    const provider = fakeProvider(() => EMPTY_HYGIENE_PLAN);
    const result = await runConsolidation({ provider, sessions: [] });

    expect(provider.prompts).toHaveLength(0);
    expect(result.hygiene.errors).toEqual([]);
  });

  it("respects the retentionDays override", async () => {
    writeEpisodeFile("2026-05-01-recent01", {
      sessionId: "s1",
      date: "2026-05-01",
      source: "test",
      summary: "A conversation from May.",
      decisions: [],
      openThreads: [],
    });
    updateMemoryIndex({ episodeEntries: [{ id: "2026-05-01-recent01", hook: "may talk" }] });

    // Huge retention: nothing compacts.
    let compaction = compactOldEpisodes(100000);
    expect(compaction.compactedIds).toEqual([]);

    // Tiny retention: the May episode compacts.
    compaction = compactOldEpisodes(1);
    expect(compaction.compactedIds).toEqual(["2026-05-01-recent01"]);
    expect(fs.existsSync(path.join(tempDir, "episodes", "compacted-2026-q2.md"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "archive", "2026-05-01-recent01.md"))).toBe(true);
  });

  it("preserves unknown frontmatter keys when a merge rewrites the surviving fact", async () => {
    writeFactWithDates(tempDir, "keep-me", "Original body.", "2026-01-01", "2026-01-01");
    const keepPath = path.join(tempDir, "facts", "keep-me.md");
    fs.writeFileSync(
      keepPath,
      fs.readFileSync(keepPath, "utf-8").replace("source: test", "source: test\npriority: high"),
      "utf-8"
    );
    upsertFactFile("absorb-me", "Duplicate body.", "test");

    const plan = JSON.stringify({
      merges: [
        { keepId: "keep-me", absorbIds: ["absorb-me"], body: "Merged body.", hook: "merged" },
      ],
      contradictions: [],
    });
    await runConsolidation({ provider: fakeProvider(() => plan), sessions: [], deep: true });

    const merged = fs.readFileSync(keepPath, "utf-8");
    expect(merged).toContain("Merged body.");
    expect(merged).toContain("created: 2026-01-01");
    expect(merged).toContain("priority: high");
  });
});

describe("parseHygienePlan", () => {
  it("accepts a fenced valid plan", () => {
    const plan = parseHygienePlan(
      "```json\n" +
        JSON.stringify({
          merges: [{ keepId: "a", absorbIds: ["b"], body: "x", hook: "y" }],
          contradictions: [{ ids: ["c", "d"] }],
        }) +
        "\n```"
    );
    expect(plan.plan).not.toBeNull();
    expect(plan.plan?.merges[0].keepId).toBe("a");
  });

  it("rejects merges with no absorbed ids", () => {
    const plan = parseHygienePlan(
      JSON.stringify({
        merges: [{ keepId: "a", absorbIds: [], body: "x", hook: "y" }],
        contradictions: [],
      })
    );
    expect(plan.plan).toBeNull();
    expect(plan.error).toContain("validation");
  });

  it("rejects invalid keep ids and oversized plans", () => {
    expect(
      parseHygienePlan(
        JSON.stringify({
          merges: [{ keepId: "../escape", absorbIds: ["b"], body: "x", hook: "y" }],
          contradictions: [],
        })
      ).plan
    ).toBeNull();

    expect(
      parseHygienePlan(
        JSON.stringify({
          merges: [],
          contradictions: Array.from({ length: 21 }, () => ({ ids: ["a", "b"] })),
        })
      ).plan
    ).toBeNull();
  });
});

describe("listFactDetails", () => {
  let tempDir: string;
  const originalMemoryDir = process.env.LLMTEST_MEMORY_DIR;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmtest-factdetails-"));
    process.env.LLMTEST_MEMORY_DIR = tempDir;
    ensureMemoryLayout();
  });

  afterEach(() => {
    if (originalMemoryDir === undefined) {
      delete process.env.LLMTEST_MEMORY_DIR;
    } else {
      process.env.LLMTEST_MEMORY_DIR = originalMemoryDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns bodies and dates, tolerating files without frontmatter", () => {
    writeFactWithDates(tempDir, "dated", "A dated fact.", "2026-01-02", "2026-03-04");
    fs.writeFileSync(path.join(tempDir, "facts", "bare.md"), "Just a body.\n", "utf-8");

    const details = listFactDetails();
    const dated = details.find((f) => f.id === "dated");
    const bare = details.find((f) => f.id === "bare");

    expect(dated?.body).toBe("A dated fact.");
    expect(dated?.created).toBe("2026-01-02");
    expect(dated?.updated).toBe("2026-03-04");
    expect(bare?.body).toBe("Just a body.");
    expect(bare?.updated).toBe("");
  });
});
