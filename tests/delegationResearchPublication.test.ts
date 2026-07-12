import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  MAX_PUBLISHED_FILES,
  publishScratchResearch,
  snapshotScratchFiles,
} from "../src/delegation/researchPublication";

describe("research scratch publication (C2d-4)", () => {
  test("publishes at most 20 new files and never republishes staged inputs", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voxara-scratch-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voxara-owned-"));
    fs.writeFileSync(path.join(scratch, "brief.md"), "trusted input");
    const baseline = snapshotScratchFiles(scratch);
    for (let i = 0; i < MAX_PUBLISHED_FILES + 1; i++) {
      fs.writeFileSync(path.join(scratch, `result-${i}.md`), `result ${i}`);
    }

    const result = publishScratchResearch({
      scratchDir: scratch,
      agentOwnedRoot: root,
      task: "A broad research topic",
      summary: "abstract",
      baseline,
      now: new Date(2026, 6, 12),
    });

    expect(result.ok).toBe(true);
    expect(result.paths).toHaveLength(MAX_PUBLISHED_FILES);
    expect(result.paths.every((file) => path.isAbsolute(file))).toBe(true);
    expect(result.paths.some((file) => path.basename(file) === "brief.md")).toBe(false);
  });

  test("honors the total byte bound without copying an oversized file", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "voxara-scratch-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voxara-owned-"));
    const baseline = snapshotScratchFiles(scratch);
    fs.writeFileSync(path.join(scratch, "too-large.md"), "x".repeat(101));

    const result = publishScratchResearch({
      scratchDir: scratch,
      agentOwnedRoot: root,
      task: "Size bounded research",
      summary: "fallback abstract",
      baseline,
      now: new Date(2026, 6, 12),
      maxBytes: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.paths).toHaveLength(1);
    expect(path.basename(result.paths[0])).toBe("2026-07-12-size-bounded-research.md");
    expect(fs.readFileSync(result.paths[0], "utf-8")).toContain("fallback abstract");
  });
});
