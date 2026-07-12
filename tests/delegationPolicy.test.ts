/**
 * Delegation policy tests (phase C2a/C2b — spec §15 "Policy").
 * Canonical root validation, traversal rejection, capability gates,
 * write isolation prerequisites, concurrency, and timeout budgets.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  evaluateDelegationRequest,
  resolveTimeoutMinutes,
} from "../src/delegation/policy";
import {
  canonicalizeWorkspace,
  isInsideAllowedRoots,
} from "../src/delegation/workspace";
import { DelegationConfig, DelegationRequest } from "../src/delegation/types";
import { TaskRecord } from "../src/engine/taskStore";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "voxara-root-"));
}

/** Turn a directory into a git repository with one commit. */
function gitInit(dir: string): void {
  const run = (args: string[]): void => {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      shell: false,
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  };
  run(["init"]);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  run(["add", "-A"]);
  run([
    "-c", "user.name=Voxara Test",
    "-c", "user.email=test@example.com",
    "-c", "commit.gpgsign=false",
    "commit", "-m", "init",
  ]);
}

function makeConfig(overrides: Partial<DelegationConfig> = {}): DelegationConfig {
  return {
    enabled: true,
    defaultBackend: "auto",
    allowedRoots: [tempRoot()],
    // Legacy-flow tests: no agent-owned class unless a test opts in.
    agentOwnedRoots: [],
    maxConcurrent: 2,
    defaultTimeoutMinutes: 15,
    maxTimeoutMinutes: 60,
    maxOutputBytes: 1024 * 1024,
    artifactRetentionDays: 14,
    allowedPrograms: [],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    task: "inspect the repository and explain the failing test",
    capability: "read_only",
    backend: "auto",
    webResearch: false,
    execution: "run",
    ...overrides,
  };
}

function runningTask(workspace: string, capability = "read_only"): TaskRecord {
  return {
    id: "task-20260712-aaaaaa",
    kind: "coding_agent",
    status: "running",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    sessionId: null,
    ownerPid: process.pid,
    workspace,
    capability,
  };
}

describe("workspace canonicalization", () => {
  test("nonexistent workspace is rejected", () => {
    const result = canonicalizeWorkspace(path.join(tempRoot(), "does-not-exist"));
    expect(result.ok).toBe(false);
  });

  test("traversal cannot escape an allowed root", () => {
    const root = tempRoot();
    const inside = path.join(root, "project");
    fs.mkdirSync(inside);

    const sneaky = canonicalizeWorkspace(path.join(inside, "..", ".."));
    expect(sneaky.ok).toBe(true);
    if (sneaky.ok) {
      expect(isInsideAllowedRoots(sneaky.canonicalPath, [root])).toBe(false);
    }
  });

  test("a sibling directory sharing the root's name prefix is outside", () => {
    const root = tempRoot();
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    const canonical = canonicalizeWorkspace(sibling);
    expect(canonical.ok).toBe(true);
    if (canonical.ok) {
      expect(isInsideAllowedRoots(canonical.canonicalPath, [root])).toBe(false);
    }
  });

  test("symlink escaping the root is caught after resolution", () => {
    const root = tempRoot();
    const outside = tempRoot();
    const link = path.join(root, "link");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      return; // symlink creation not permitted in this environment — skip
    }
    const canonical = canonicalizeWorkspace(link);
    expect(canonical.ok).toBe(true);
    if (canonical.ok) {
      expect(isInsideAllowedRoots(canonical.canonicalPath, [root])).toBe(false);
      expect(isInsideAllowedRoots(canonical.canonicalPath, [outside])).toBe(true);
    }
  });
});

describe("evaluateDelegationRequest", () => {
  test("rejected when delegation is disabled", () => {
    const decision = evaluateDelegationRequest(
      makeRequest(),
      makeConfig({ enabled: false }),
      []
    );
    expect(decision.outcome).toBe("rejected");
  });

  test("read_only inside an allowed root is allowed", () => {
    const config = makeConfig();
    const decision = evaluateDelegationRequest(
      makeRequest({ workspace: config.allowedRoots[0] }),
      config,
      []
    );
    expect(decision.outcome).toBe("allowed");
  });

  test("workspace outside the allowed roots is rejected", () => {
    const config = makeConfig();
    const decision = evaluateDelegationRequest(
      makeRequest({ workspace: tempRoot() }),
      config,
      []
    );
    expect(decision.outcome).toBe("rejected");
  });

  test("external_action may start its prepare stage; apply stays behind delegate_approve (C2c)", () => {
    const config = makeConfig();
    const decision = evaluateDelegationRequest(
      makeRequest({ capability: "external_action", workspace: config.allowedRoots[0] }),
      config,
      []
    );
    expect(decision.outcome).toBe("allowed");
  });

  test("execution=prepare is only valid for external_action", () => {
    const config = makeConfig();
    const rejected = evaluateDelegationRequest(
      makeRequest({ execution: "prepare", workspace: config.allowedRoots[0] }),
      config,
      []
    );
    expect(rejected.outcome).toBe("rejected");

    const allowed = evaluateDelegationRequest(
      makeRequest({
        capability: "external_action",
        execution: "prepare",
        workspace: config.allowedRoots[0],
      }),
      config,
      []
    );
    expect(allowed.outcome).toBe("allowed");
  });

  test("workspace_write on a Git repository inside the roots is allowed (C2b)", () => {
    const config = makeConfig();
    const repo = path.join(config.allowedRoots[0], "project");
    fs.mkdirSync(repo);
    gitInit(repo);
    const decision = evaluateDelegationRequest(
      makeRequest({ capability: "workspace_write", workspace: repo }),
      config,
      []
    );
    expect(decision.outcome).toBe("allowed");
  });

  test("workspace_write on a non-Git workspace is rejected with guidance", () => {
    const config = makeConfig();
    const decision = evaluateDelegationRequest(
      makeRequest({ capability: "workspace_write", workspace: config.allowedRoots[0] }),
      config,
      []
    );
    expect(decision.outcome).toBe("rejected");
    if (decision.outcome === "rejected") {
      expect(decision.reason).toContain("Git repository");
    }
  });

  test("workspace_write is rejected when the repo root sits above the allowed root", () => {
    // Allowed root is a subdirectory of the repository: a worktree would
    // expose the whole repo, beyond the approved scope.
    const repo = tempRoot();
    gitInit(repo);
    const sub = path.join(repo, "allowed-sub");
    fs.mkdirSync(sub);
    const config = makeConfig({ allowedRoots: [sub] });
    const decision = evaluateDelegationRequest(
      makeRequest({ capability: "workspace_write", workspace: sub }),
      config,
      []
    );
    expect(decision.outcome).toBe("rejected");
    if (decision.outcome === "rejected") {
      expect(decision.reason).toContain("repository root");
    }
  });

  test("web_research with workspace_write is rejected (v1)", () => {
    const config = makeConfig();
    const decision = evaluateDelegationRequest(
      makeRequest({
        capability: "workspace_write",
        webResearch: true,
        workspace: config.allowedRoots[0],
      }),
      config,
      []
    );
    expect(decision.outcome).toBe("rejected");
  });

  test("web_research read_only needs no workspace", () => {
    const decision = evaluateDelegationRequest(
      makeRequest({ webResearch: true, workspace: undefined }),
      makeConfig(),
      []
    );
    expect(decision.outcome).toBe("allowed");
  });

  test("concurrency budget rejects when full", () => {
    const config = makeConfig({ maxConcurrent: 1 });
    const decision = evaluateDelegationRequest(
      makeRequest({ workspace: config.allowedRoots[0] }),
      config,
      [runningTask(config.allowedRoots[0])]
    );
    expect(decision.outcome).toBe("rejected");
  });

  test("second writer for the same workspace is rejected", () => {
    const config = makeConfig({ maxConcurrent: 5 });
    const workspace = config.allowedRoots[0];
    const decision = evaluateDelegationRequest(
      makeRequest({ capability: "workspace_write", workspace }),
      config,
      [runningTask(workspace, "workspace_write")]
    );
    expect(decision.outcome).toBe("rejected");
  });

  test("readers may coexist", () => {
    const config = makeConfig({ maxConcurrent: 5 });
    const workspace = config.allowedRoots[0];
    const decision = evaluateDelegationRequest(
      makeRequest({ workspace }),
      config,
      [runningTask(workspace, "read_only")]
    );
    expect(decision.outcome).toBe("allowed");
  });
});

describe("resolveTimeoutMinutes", () => {
  const config = makeConfig();

  test("missing/invalid values fall back to the default", () => {
    expect(resolveTimeoutMinutes(undefined, config)).toBe(15);
    expect(resolveTimeoutMinutes(-3, config)).toBe(15);
    expect(resolveTimeoutMinutes(Number.NaN, config)).toBe(15);
  });

  test("requests are clamped to the maximum", () => {
    expect(resolveTimeoutMinutes(20, config)).toBe(20);
    expect(resolveTimeoutMinutes(500, config)).toBe(60);
  });
});
