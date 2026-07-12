import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ensureMemoryLayout,
  getMemoryPaths,
  readMemoryIndex,
  memoryIndexHasEntries,
  listMemoryEntries,
  readMemoryEntry,
  appendInboxNote,
  countInboxNotes,
  buildMemoryContextBlock,
  buildMemoryPreambleMessages,
  detectRememberIntent,
  MEMORY_INDEX_SEED,
} from "../src/memory/memoryStore";

describe("memoryStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmtest-memory-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the full layout and seeds MEMORY.md, idempotently", () => {
    const paths = ensureMemoryLayout(tempDir);

    expect(fs.existsSync(paths.factsDir)).toBe(true);
    expect(fs.existsSync(paths.episodesDir)).toBe(true);
    expect(fs.existsSync(paths.inboxDir)).toBe(true);
    expect(fs.existsSync(paths.archiveDir)).toBe(true);
    expect(fs.readFileSync(paths.indexFile, "utf-8")).toBe(MEMORY_INDEX_SEED);

    // Second run must not overwrite a user-edited index
    fs.writeFileSync(paths.indexFile, "# Mine\n- [x](facts/x.md) — edited", "utf-8");
    ensureMemoryLayout(tempDir);
    expect(fs.readFileSync(paths.indexFile, "utf-8")).toContain("edited");
  });

  it("returns an empty index when MEMORY.md is missing", () => {
    expect(readMemoryIndex(tempDir)).toBe("");
  });

  it("detects whether the index has entries", () => {
    expect(memoryIndexHasEntries(MEMORY_INDEX_SEED)).toBe(false);
    expect(memoryIndexHasEntries("## Facts\n- [a](facts/a.md) — hook")).toBe(true);
  });

  it("lists and reads facts and episodes", () => {
    const paths = ensureMemoryLayout(tempDir);
    fs.writeFileSync(path.join(paths.factsDir, "likes-tea.md"), "User likes tea.", "utf-8");
    fs.writeFileSync(path.join(paths.episodesDir, "2026-07-01-setup.md"), "We set things up.", "utf-8");
    fs.writeFileSync(path.join(paths.factsDir, "notes.txt"), "ignored", "utf-8");

    const entries = listMemoryEntries(tempDir);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id)).toEqual(["likes-tea", "2026-07-01-setup"]);

    expect(readMemoryEntry("likes-tea", tempDir)?.content).toBe("User likes tea.");
    expect(readMemoryEntry("likes-tea", tempDir)?.type).toBe("fact");
    expect(readMemoryEntry("2026-07-01-setup", tempDir)?.type).toBe("episode");
    expect(readMemoryEntry("unknown-id", tempDir)).toBeNull();
  });

  it("rejects ids that could escape the memory directory", () => {
    const paths = ensureMemoryLayout(tempDir);
    fs.writeFileSync(path.join(paths.root, "secret.md"), "secret", "utf-8");

    expect(readMemoryEntry("../secret", tempDir)).toBeNull();
    expect(readMemoryEntry("..\\secret", tempDir)).toBeNull();
    expect(readMemoryEntry("facts/../secret", tempDir)).toBeNull();
    expect(readMemoryEntry("", tempDir)).toBeNull();
  });

  it("appends inbox notes with frontmatter and counts them", () => {
    expect(countInboxNotes(tempDir)).toBe(0);

    const filePath = appendInboxNote("The user's cat is named Miso.", "memory_note tool", tempDir);
    const content = fs.readFileSync(filePath, "utf-8");

    expect(content).toContain("source: memory_note tool");
    expect(content).toContain("created: ");
    expect(content).toContain("The user's cat is named Miso.");

    appendInboxNote("Second note.", "test", tempDir);
    expect(countInboxNotes(tempDir)).toBe(2);
  });

  it("builds an empty context block when the index has no entries", () => {
    ensureMemoryLayout(tempDir);
    expect(buildMemoryContextBlock({ baseDir: tempDir })).toBe("");
    expect(buildMemoryPreambleMessages({ baseDir: tempDir })).toEqual([]);
  });

  it("keeps tool instructions even when the index is empty", () => {
    ensureMemoryLayout(tempDir);
    const block = buildMemoryContextBlock({
      withToolInstructions: true,
      baseDir: tempDir,
    });
    expect(block).toContain("no entries yet");
    expect(block).toContain("memory_note");
  });

  it("builds the context block and preamble when memory exists", () => {
    const paths = ensureMemoryLayout(tempDir);
    fs.writeFileSync(
      paths.indexFile,
      "# Memory Index\n\n## Facts\n- [likes-tea](facts/likes-tea.md) — likes tea\n",
      "utf-8"
    );

    const plain = buildMemoryContextBlock({ baseDir: tempDir });
    expect(plain).toContain("likes-tea");
    expect(plain).not.toContain("memory_read");

    const withTools = buildMemoryContextBlock({
      withToolInstructions: true,
      baseDir: tempDir,
    });
    expect(withTools).toContain("memory_read");
    expect(withTools).toContain("memory_note");

    const preamble = buildMemoryPreambleMessages({ baseDir: tempDir });
    expect(preamble).toHaveLength(2);
    expect(preamble[0].role).toBe("user");
    expect(preamble[0].content).toContain("likes-tea");
    expect(preamble[1].role).toBe("model");
  });
});

describe("detectRememberIntent", () => {
  it("matches explicit remember requests in French and English", () => {
    const positives = [
      "Retiens que mon prénom c'est Alexy.",
      "J'ai envie que tu te rappelles que mon prénom c'est Alexis, avec un Y.",
      "Rappelle-toi que je travaille le samedi.",
      "Souviens-toi que je déteste le café.",
      "N'oublie pas que j'ai un rendez-vous demain.",
      "Mémorise que mon chat s'appelle Miso.",
      "Garde en mémoire que je préfère les réponses courtes.",
      "Note bien que la réunion est à 15h.",
      "Remember that my birthday is March 3rd.",
      "Don't forget I live in Geneva.",
      "Keep in mind that I prefer short answers.",
    ];

    for (const utterance of positives) {
      expect(detectRememberIntent(utterance)).toBe(true);
    }
  });

  it("does not match the user talking about their own memories", () => {
    const negatives = [
      "Je me souviens de mes vacances à Paris.",
      "Ça me rappelle mon enfance.",
      "Quel temps fait-il aujourd'hui ?",
      "I remembered to bring my keys.",
      "Tu peux me raconter une histoire ?",
    ];

    for (const utterance of negatives) {
      expect(detectRememberIntent(utterance)).toBe(false);
    }
  });
});
