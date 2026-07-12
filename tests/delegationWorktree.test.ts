/**
 * Git worktree isolation tests (phase C2b — spec §15 "Isolation").
 * Real git in temporary repositories; no backend, credentials, or network.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  collectWorktreeChanges,
  createTaskWorktree,
  getGitRepoRoot,
  removeTaskWorktree,
} from "../src/delegation/worktree";

jest.setTimeout(30000);

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a git repo with one committed file. */
function initRepo(): string {
  const dir = tempDir("voxara-repo-");
  git(dir, ["init"]);
  fs.writeFileSync(path.join(dir, "app.txt"), "version 1\n");
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c", "user.name=Voxara Test",
    "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false",
    "commit", "-m", "init",
  ]);
  return fs.realpathSync(dir);
}

describe("getGitRepoRoot", () => {
  test("resolves the repository root from a subdirectory", () => {
    const repo = initRepo();
    const sub = path.join(repo, "src");
    fs.mkdirSync(sub);
    expect(getGitRepoRoot(sub)?.toLowerCase()).toBe(repo.toLowerCase());
  });

  test("returns null outside any repository", () => {
    // A stray repository above the temp dir (e.g. an accidental `git init`
    // in C:\) must not leak into this test: stop the upward search at tmpdir.
    const previous = process.env.GIT_CEILING_DIRECTORIES;
    // git only honors ceiling entries with forward slashes, even on Windows.
    process.env.GIT_CEILING_DIRECTORIES = fs
      .realpathSync(os.tmpdir())
      .replace(/\\/g, "/");
    try {
      expect(getGitRepoRoot(tempDir("voxara-norepo-"))).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previous;
      }
    }
  });
});

describe("createTaskWorktree", () => {
  test("creates a detached worktree isolated from the main tree", () => {
    const repo = initRepo();
    const parent = tempDir("voxara-wtparent-");
    const worktree = createTaskWorktree(repo, parent);

    expect(worktree.ok).toBe(true);
    if (!worktree.ok) return;
    expect(fs.existsSync(path.join(worktree.worktreeDir, "app.txt"))).toBe(true);
    expect(worktree.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    // Writes in the worktree never reach the user's tree (§7).
    fs.writeFileSync(path.join(worktree.worktreeDir, "new.txt"), "made by agent\n");
    fs.writeFileSync(path.join(worktree.worktreeDir, "app.txt"), "version 2\n");
    expect(fs.existsSync(path.join(repo, "new.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "app.txt"), "utf-8")).toBe("version 1\n");
  });

  test("fails cleanly on a repository without a commit", () => {
    const dir = tempDir("voxara-empty-");
    git(dir, ["init"]);
    const worktree = createTaskWorktree(dir, tempDir("voxara-wtparent-"));
    expect(worktree.ok).toBe(false);
    if (worktree.ok) return;
    expect(worktree.reason).toContain("commit");
  });
});

describe("collectWorktreeChanges", () => {
  test("reports modified and newly created files with a patch artifact", () => {
    const repo = initRepo();
    const parent = tempDir("voxara-wtparent-");
    const worktree = createTaskWorktree(repo, parent);
    expect(worktree.ok).toBe(true);
    if (!worktree.ok) return;

    fs.writeFileSync(path.join(worktree.worktreeDir, "app.txt"), "version 2\n");
    fs.writeFileSync(path.join(worktree.worktreeDir, "new.txt"), "created\n");

    const changes = collectWorktreeChanges(
      worktree.worktreeDir,
      worktree.baseCommit,
      parent
    );

    expect(changes.hasChanges).toBe(true);
    expect(changes.changedFiles.some((f) => f.includes("app.txt"))).toBe(true);
    expect(changes.changedFiles.some((f) => f.includes("new.txt"))).toBe(true);
    expect(changes.summary).toContain("app.txt");
    expect(changes.patchFile).toBeTruthy();
    const patch = fs.readFileSync(changes.patchFile!, "utf-8");
    expect(patch).toContain("version 2");
    expect(patch).toContain("created");
  });

  test("an untouched worktree reports no changes and writes no patch", () => {
    const repo = initRepo();
    const parent = tempDir("voxara-wtparent-");
    const worktree = createTaskWorktree(repo, parent);
    expect(worktree.ok).toBe(true);
    if (!worktree.ok) return;

    const changes = collectWorktreeChanges(
      worktree.worktreeDir,
      worktree.baseCommit,
      parent
    );
    expect(changes.hasChanges).toBe(false);
    expect(changes.patchFile).toBeNull();
    expect(fs.existsSync(path.join(parent, "changes.patch"))).toBe(false);
  });

  test("two task worktrees of the same repository do not overlap", () => {
    const repo = initRepo();
    const a = createTaskWorktree(repo, tempDir("voxara-wt-a-"));
    const b = createTaskWorktree(repo, tempDir("voxara-wt-b-"));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    fs.writeFileSync(path.join(a.worktreeDir, "only-a.txt"), "a\n");
    expect(fs.existsSync(path.join(b.worktreeDir, "only-a.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "only-a.txt"))).toBe(false);
  });
});

describe("removeTaskWorktree", () => {
  test("removes the directory and its registration in the source repo", () => {
    const repo = initRepo();
    const worktree = createTaskWorktree(repo, tempDir("voxara-wtparent-"));
    expect(worktree.ok).toBe(true);
    if (!worktree.ok) return;

    removeTaskWorktree(repo, worktree.worktreeDir);

    expect(fs.existsSync(worktree.worktreeDir)).toBe(false);
    const list = git(repo, ["worktree", "list", "--porcelain"]);
    expect(list.toLowerCase()).not.toContain(
      worktree.worktreeDir.toLowerCase().replace(/\\/g, "/")
    );
  });
});
