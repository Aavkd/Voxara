import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TOOL_REGISTRY, getAllToolNames } from "../src/providers/tools/index";
import { ensureMemoryLayout } from "../src/memory/memoryStore";

describe("memory tools", () => {
  let tempDir: string;
  const originalMemoryDir = process.env.LLMTEST_MEMORY_DIR;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmtest-memtools-"));
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

  it("registers memory_read and memory_note in the tool registry", () => {
    expect(getAllToolNames()).toEqual(
      expect.arrayContaining(["memory_read", "memory_note"])
    );
  });

  it("memory_read returns entry content and errors on unknown ids", async () => {
    const paths = ensureMemoryLayout();
    fs.writeFileSync(
      path.join(paths.factsDir, "likes-tea.md"),
      "User likes tea.",
      "utf-8"
    );

    const tool = TOOL_REGISTRY["memory_read"];
    await expect(tool.execute({ id: "likes-tea" }, "")).resolves.toBe(
      "User likes tea."
    );

    const missing = await tool.execute({ id: "nope" }, "");
    expect(String(missing)).toContain("error");

    const empty = await tool.execute({}, "");
    expect(String(empty)).toContain("error");
  });

  it("memory_note writes a raw note into the inbox", async () => {
    const paths = ensureMemoryLayout();
    const tool = TOOL_REGISTRY["memory_note"];

    const result = await tool.execute(
      { text: "The user's birthday is March 3rd." },
      ""
    );
    expect(String(result)).toContain("Noted");

    const notes = fs
      .readdirSync(paths.inboxDir)
      .filter((name) => name.endsWith(".md"));
    expect(notes).toHaveLength(1);

    const content = fs.readFileSync(path.join(paths.inboxDir, notes[0]), "utf-8");
    expect(content).toContain("The user's birthday is March 3rd.");
    expect(content).toContain("source: memory_note tool");

    const empty = await tool.execute({ text: "   " }, "");
    expect(String(empty)).toContain("error");
  });
});
