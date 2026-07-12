/**
 * Action-manifest tests (phase C2c — spec §15 "Approval": prepare produces a
 * manifest; apply cannot exceed it; denial and cancellation leave source data
 * unchanged; traversal and allowlist escapes are rejected).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ActionManifest,
  applyManifest,
  MANIFEST_MAX_ACTIONS,
  summarizeManifest,
  validateManifest,
} from "../src/delegation/manifest";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setup() {
  const workspace = tempDir("voxara-manifest-ws-");
  const planDir = tempDir("voxara-manifest-plan-");
  const artifactDir = tempDir("voxara-manifest-art-");
  const context = { workspace, planDir, allowedPrograms: ["node"] };
  const applyOptions = {
    ...context,
    artifactDir,
    timeoutMs: 10000,
    maxOutputBytes: 1024 * 1024,
  };
  return { workspace, planDir, artifactDir, context, applyOptions };
}

const manifestJson = (actions: unknown[], summary = "plan"): string =>
  JSON.stringify({ version: 1, summary, actions });

describe("validateManifest", () => {
  test("accepts a well-formed manifest and echoes its actions", () => {
    const { context, planDir } = setup();
    fs.writeFileSync(path.join(planDir, "payload.txt"), "hello");
    const result = validateManifest(
      manifestJson([
        { type: "create_dir", path: "out" },
        { type: "create", path: "out/hello.txt", from: "payload.txt" },
        { type: "move", path: "out/hello.txt", to: "out/hi.txt" },
        { type: "delete", path: "out/hi.txt" },
      ]),
      context
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.actions).toHaveLength(4);
      expect(result.manifest.summary).toBe("plan");
    }
  });

  test.each([
    ["not json", "{{{"],
    ["not an object", "[1,2]"],
    ["wrong version", JSON.stringify({ version: 2, actions: [{ type: "delete", path: "x" }] })],
    ["empty actions", manifestJson([])],
    ["unknown action type", manifestJson([{ type: "format_disk", path: "x" }])],
  ])("rejects %s", (_label, raw) => {
    const { context } = setup();
    expect(validateManifest(raw, context).ok).toBe(false);
  });

  test("rejects more than the action budget", () => {
    const { context } = setup();
    const actions = Array.from({ length: MANIFEST_MAX_ACTIONS + 1 }, (_, i) => ({
      type: "create_dir",
      path: `d${i}`,
    }));
    const result = validateManifest(manifestJson(actions), context);
    expect(result.ok).toBe(false);
  });

  test.each([
    ["absolute path", { type: "delete", path: "C:\\Windows\\system.ini" }],
    ["drive-relative path", { type: "delete", path: "C:evil.txt" }],
    ["parent traversal", { type: "delete", path: "../outside.txt" }],
    ["embedded traversal", { type: "move", path: "a/../../b", to: "c" }],
    ["traversal in to", { type: "move", path: "a.txt", to: "../../b.txt" }],
    ["payload escaping the plan dir", { type: "create", path: "a.txt", from: "../secret.txt" }],
  ])("rejects %s", (_label, action) => {
    const { context } = setup();
    const result = validateManifest(manifestJson([action]), context);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/escape|relative/i);
    }
  });

  test("rejects a create whose payload file is missing from the plan directory", () => {
    const { context } = setup();
    const result = validateManifest(
      manifestJson([{ type: "create", path: "a.txt", from: "missing.txt" }]),
      context
    );
    expect(result.ok).toBe(false);
  });

  test("rejects execute for a program outside the allowlist, and program paths", () => {
    const { context } = setup();
    expect(
      validateManifest(manifestJson([{ type: "execute", program: "powershell" }]), context).ok
    ).toBe(false);
    expect(
      validateManifest(
        manifestJson([{ type: "execute", program: "C:\\evil\\node.exe" }]),
        context
      ).ok
    ).toBe(false);
    // Empty allowlist gives configuration guidance.
    const noPrograms = validateManifest(
      manifestJson([{ type: "execute", program: "node" }]),
      { ...context, allowedPrograms: [] }
    );
    expect(noPrograms.ok).toBe(false);
    if (!noPrograms.ok) {
      expect(noPrograms.reason).toContain("DELEGATION_ALLOWED_PROGRAMS");
    }
  });

  test("accepts an allowed execute with a plan-dir script", () => {
    const { context, planDir } = setup();
    fs.writeFileSync(path.join(planDir, "run.js"), "console.log('ok')");
    const result = validateManifest(
      manifestJson([{ type: "execute", program: "node", script: "run.js", args: ["--x"] }]),
      context
    );
    expect(result.ok).toBe(true);
  });
});

describe("summarizeManifest", () => {
  test("is bounded and lists the concrete effects", () => {
    const actions = Array.from({ length: 40 }, (_, i) => ({
      type: "delete" as const,
      path: `photos/dup-${i}.jpg`,
    }));
    const text = summarizeManifest({ version: 1, summary: "Dedupe photos", actions });
    expect(text).toContain("Dedupe photos");
    expect(text).toContain("40 action(s)");
    expect(text).toContain("and 28 more");
    expect(text.length).toBeLessThanOrEqual(1000);
  });
});

describe("applyManifest", () => {
  test("applies create_dir/create/move/copy/delete and verifies each step", async () => {
    const { workspace, planDir, applyOptions } = setup();
    fs.writeFileSync(path.join(workspace, "old.txt"), "old");
    fs.writeFileSync(path.join(workspace, "src.txt"), "copy me");
    fs.writeFileSync(path.join(planDir, "payload.txt"), "fresh");

    const manifest: ActionManifest = {
      version: 1,
      actions: [
        { type: "create_dir", path: "out" },
        { type: "create", path: "out/new.txt", from: "payload.txt" },
        { type: "move", path: "old.txt", to: "out/old.txt" },
        { type: "copy", path: "src.txt", to: "out/src-copy.txt" },
        { type: "delete", path: "src.txt" },
      ],
    };

    const result = await applyManifest(manifest, applyOptions);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.appliedCount).toBe(5);
    expect(fs.readFileSync(path.join(workspace, "out", "new.txt"), "utf-8")).toBe("fresh");
    expect(fs.existsSync(path.join(workspace, "old.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "out", "old.txt"), "utf-8")).toBe("old");
    expect(fs.readFileSync(path.join(workspace, "out", "src-copy.txt"), "utf-8")).toBe("copy me");
    expect(fs.existsSync(path.join(workspace, "src.txt"))).toBe(false);
  });

  test("stops at the first precondition divergence and reports partial progress", async () => {
    const { workspace, applyOptions } = setup();
    fs.writeFileSync(path.join(workspace, "a.txt"), "a");

    const manifest: ActionManifest = {
      version: 1,
      actions: [
        { type: "move", path: "a.txt", to: "b.txt" },
        // The workspace changed since approval: this source does not exist.
        { type: "move", path: "vanished.txt", to: "c.txt" },
        { type: "delete", path: "b.txt" },
      ],
    };

    const result = await applyManifest(manifest, applyOptions);
    expect(result.ok).toBe(false);
    expect(result.appliedCount).toBe(1);
    expect(result.error).toContain("workspace changed");
    // The already-applied action is not undone; the later one never ran.
    expect(fs.existsSync(path.join(workspace, "b.txt"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "c.txt"))).toBe(false);
  });

  test("refuses unapproved overwrites and non-empty directory deletes", async () => {
    const { workspace, applyOptions } = setup();
    fs.writeFileSync(path.join(workspace, "a.txt"), "a");
    fs.writeFileSync(path.join(workspace, "b.txt"), "precious");
    fs.mkdirSync(path.join(workspace, "full"));
    fs.writeFileSync(path.join(workspace, "full", "keep.txt"), "keep");

    const overwrite = await applyManifest(
      { version: 1, actions: [{ type: "move", path: "a.txt", to: "b.txt" }] },
      applyOptions
    );
    expect(overwrite.ok).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "b.txt"), "utf-8")).toBe("precious");

    const rmdir = await applyManifest(
      { version: 1, actions: [{ type: "delete", path: "full" }] },
      applyOptions
    );
    expect(rmdir.ok).toBe(false);
    expect(fs.existsSync(path.join(workspace, "full", "keep.txt"))).toBe(true);
  });

  test("re-checks the program allowlist at apply time", async () => {
    const { planDir, applyOptions } = setup();
    fs.writeFileSync(path.join(planDir, "run.js"), "console.log('ok')");
    const manifest: ActionManifest = {
      version: 1,
      actions: [{ type: "execute", program: "node", script: "run.js" }],
    };
    // The allowlist was narrowed between approval and apply.
    const result = await applyManifest(manifest, {
      ...applyOptions,
      allowedPrograms: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no longer in the allowed list");
  });

  test("cancellation between actions stops the apply cleanly", async () => {
    const { workspace, applyOptions } = setup();
    fs.writeFileSync(path.join(workspace, "a.txt"), "a");
    fs.writeFileSync(path.join(workspace, "b.txt"), "b");

    let calls = 0;
    const result = await applyManifest(
      {
        version: 1,
        actions: [
          { type: "delete", path: "a.txt" },
          { type: "delete", path: "b.txt" },
        ],
      },
      { ...applyOptions, isCancelled: () => ++calls > 1 }
    );
    expect(result.ok).toBe(false);
    expect(result.appliedCount).toBe(1);
    expect(result.error).toContain("cancelled");
    expect(fs.existsSync(path.join(workspace, "b.txt"))).toBe(true);
  });
});
