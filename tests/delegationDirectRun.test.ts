/**
 * Agent-owned direct-run tests (phase C2d §4, §12). Write tasks inside an
 * agent-owned root run directly in the workspace, guarded by Git
 * checkpoints, and deliver absolute file paths. Fake in-process backend;
 * real git in temporary directories; no credentials or network.
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DelegationService } from "../src/delegation/service";
import {
  BackendRunOutcome,
  DelegationConfig,
  DelegationRequest,
  ICodingAgentBackend,
} from "../src/delegation/types";
import { getTask } from "../src/engine/taskStore";
import { listDeliveries } from "../src/engine/deliveryQueue";

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

interface FakeBackendHandle {
  backend: ICodingAgentBackend;
  finish(outcome: Partial<BackendRunOutcome>): void;
  startCalls: number;
  lastWorkspace?: string;
  lastTask?: string;
}

function createFakeBackend(): FakeBackendHandle {
  let resolveRun: ((outcome: BackendRunOutcome) => void) | null = null;
  const handle: FakeBackendHandle = {
    startCalls: 0,
    backend: {
      name: "codex",
      async detect() {
        return { name: "codex" as const, available: true, version: "fake", executablePath: "fake" };
      },
      async start(context, task) {
        handle.startCalls++;
        handle.lastWorkspace = context.workspace;
        handle.lastTask = task;
        const wait = new Promise<BackendRunOutcome>((resolve) => {
          resolveRun = resolve;
        });
        return {
          pid: 12345,
          wait,
          cancel: async () => {
            resolveRun?.({ ok: false, summary: "", exitCode: null, error: "cancelled" });
          },
        };
      },
    },
    finish(outcome) {
      resolveRun?.({ ok: true, summary: "done", exitCode: 0, ...outcome });
    },
  };
  return handle;
}

function setup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "voxara-direct-state-"));
  const agentRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "voxara-direct-ws-"))
  );
  const fake = createFakeBackend();
  const config: DelegationConfig = {
    enabled: true,
    defaultBackend: "auto",
    allowedRoots: [agentRoot],
    agentOwnedRoots: [agentRoot],
    maxConcurrent: 2,
    defaultTimeoutMinutes: 15,
    maxTimeoutMinutes: 60,
    maxOutputBytes: 1024 * 1024,
    artifactRetentionDays: 14,
    allowedPrograms: [],
  };
  const service = new DelegationService({
    config,
    backends: [fake.backend],
    stateBaseDir: stateDir,
  });
  return { service, fake, stateDir, agentRoot };
}

function writeRequest(
  workspace: string,
  overrides: Partial<DelegationRequest> = {}
): DelegationRequest {
  return {
    task: "write the requested document into the workspace",
    capability: "workspace_write",
    backend: "auto",
    workspace,
    webResearch: false,
    execution: "run",
    ...overrides,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("agent-owned direct run", () => {
  test("bootstraps the root as a git repo and runs directly in the workspace", async () => {
    const { service, fake, agentRoot } = setup();

    const result = await service.dispatch(writeRequest(agentRoot));
    expect(result.status).toBe("running");
    expect(result.message).toContain("directly");

    // No worktree: the backend's cwd is the workspace itself.
    expect(fake.lastWorkspace!.toLowerCase()).toBe(agentRoot.toLowerCase());
    // The root became its own repository with a base commit.
    expect(fs.existsSync(path.join(agentRoot, ".git"))).toBe(true);
    expect(git(agentRoot, ["rev-parse", "HEAD"]).trim()).toMatch(/^[0-9a-f]{40}$/);

    fake.finish({ summary: "document written" });
    await tick();
  });

  test("does not re-init an existing repository", async () => {
    const { service, fake, agentRoot } = setup();
    await service.dispatch(writeRequest(agentRoot));
    const headBefore = git(agentRoot, ["rev-parse", "HEAD"]).trim();
    fake.finish({});
    await tick();

    // Second dispatch: same repo, same initial commit ancestry.
    await service.dispatch(writeRequest(agentRoot));
    const headAfter = git(agentRoot, ["rev-parse", "HEAD"]).trim();
    expect(git(agentRoot, ["merge-base", headBefore, headAfter]).trim()).toBe(
      headBefore
    );
    fake.finish({});
    await tick();
  });

  test("checkpoints dirty state before the run, then commits and delivers the task's changes", async () => {
    const { service, fake, stateDir, agentRoot } = setup();

    // Pre-existing uncommitted user state must survive in a checkpoint.
    fs.writeFileSync(path.join(agentRoot, "notes.txt"), "user notes\n");

    const result = await service.dispatch(writeRequest(agentRoot));
    expect(result.status).toBe("running");
    const log1 = git(agentRoot, ["log", "--format=%s"]);
    expect(log1).toContain(`voxara: checkpoint before ${result.taskId}`);

    // The backend writes files directly into the workspace.
    fs.writeFileSync(path.join(agentRoot, "rapport.md"), "# Rapport\ncontenu\n");
    fs.mkdirSync(path.join(agentRoot, "projects"), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, "projects", "app.js"), "console.log(1)\n");
    fake.finish({ summary: "wrote rapport.md and projects/app.js" });
    await tick();

    const task = getTask(result.taskId!, stateDir)!;
    expect(task.status).toBe("done");
    expect(task.runMode).toBe("direct");
    expect(task.taskCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(task.diffSummary).toContain("rapport.md");
    // Deliverable list: absolute paths.
    const files = task.changedFiles ?? [];
    expect(files.some((f) => f.toLowerCase() === path.join(agentRoot, "rapport.md").toLowerCase())).toBe(true);
    expect(files.some((f) => f.toLowerCase().endsWith(path.join("projects", "app.js").toLowerCase()))).toBe(true);

    // The task's commit contains exactly the run's changes, not the checkpoint's.
    const committed = git(agentRoot, ["show", "--name-only", "--format=%s", task.taskCommit!]);
    expect(committed).toContain(`${task.id}:`);
    expect(committed).toContain("rapport.md");
    expect(committed).not.toContain("notes.txt");

    // Delivery: applied-in-place wording plus a real absolute path.
    const deliveries = listDeliveries(stateDir);
    const done = deliveries.find((d) => d.refId === task.id);
    expect(done).toBeDefined();
    expect(done!.text).toContain("directement dans ton espace de travail");
    expect(done!.text.toLowerCase()).toContain("rapport.md");
  });

  test("a run with no changes delivers an explicit no-file statement", async () => {
    const { service, fake, stateDir, agentRoot } = setup();
    const result = await service.dispatch(writeRequest(agentRoot));
    fake.finish({ summary: "answered in text only" });
    await tick();

    const task = getTask(result.taskId!, stateDir)!;
    expect(task.status).toBe("done");
    expect(task.taskCommit).toBeNull();
    expect(task.changedFiles).toEqual([]);
    const delivery = listDeliveries(stateDir).find((d) => d.refId === task.id);
    expect(delivery!.text).toContain("Aucun fichier n'a été produit");
  });

  test("a failed run leaves partial changes in place and points at the checkpoint", async () => {
    const { service, fake, stateDir, agentRoot } = setup();
    const result = await service.dispatch(writeRequest(agentRoot));

    fs.writeFileSync(path.join(agentRoot, "partial.txt"), "half-done\n");
    fake.finish({ ok: false, summary: "", error: "backend crashed" });
    await tick();

    const task = getTask(result.taskId!, stateDir)!;
    expect(task.status).toBe("failed");
    // Evidence preserved, not rolled back.
    expect(fs.existsSync(path.join(agentRoot, "partial.txt"))).toBe(true);
    const delivery = listDeliveries(stateDir).find((d) => d.refId === task.id);
    expect(delivery!.text).toContain("modifications partielles");
    expect(delivery!.text).toContain(task.baseCommit!.slice(0, 10));
  });

  test("creates a missing project subdirectory inside the root and runs there", async () => {
    const { service, fake, stateDir, agentRoot } = setup();
    const project = path.join(agentRoot, "projects", "myapp");

    const result = await service.dispatch(writeRequest(project));
    expect(result.status).toBe("running");
    expect(fs.existsSync(project)).toBe(true);
    expect(fake.lastWorkspace!.toLowerCase()).toBe(project.toLowerCase());

    // Task N+1 sees task N's files: continuity through the shared root.
    fs.writeFileSync(path.join(project, "index.js"), "step 1\n");
    fake.finish({ summary: "step 1 done" });
    await tick();
    expect(getTask(result.taskId!, stateDir)!.status).toBe("done");

    const second = await service.dispatch(writeRequest(project));
    expect(second.status).toBe("running");
    expect(fs.readFileSync(path.join(project, "index.js"), "utf-8")).toBe("step 1\n");
    fake.finish({});
    await tick();
  });

  test("project journal instruction reaches the delegate and its journal is committed", async () => {
    const { service, fake, stateDir, agentRoot } = setup();
    const result = await service.dispatch(writeRequest(agentRoot));

    expect(fake.lastTask).toContain("read `DECISIONS.md`");
    expect(fake.lastTask).toContain("append a dated entry");
    fs.writeFileSync(
      path.join(agentRoot, "DECISIONS.md"),
      "# Decisions\n\n## 2026-07-12\n- Built the first slice.\n"
    );
    fake.finish({ summary: "journal updated" });
    await tick();

    const task = getTask(result.taskId!, stateDir)!;
    expect(task.status).toBe("done");
    expect(task.changedFiles).toContain(path.join(agentRoot, "DECISIONS.md"));
    const committed = git(agentRoot, ["show", "--name-only", "--format=", task.taskCommit!]);
    expect(committed).toContain("DECISIONS.md");
  });

  test("rejects a second writer anywhere in the same agent-owned root", async () => {
    const { service, fake, agentRoot } = setup();
    const a = path.join(agentRoot, "projects", "a");
    const b = path.join(agentRoot, "projects", "b");

    const first = await service.dispatch(writeRequest(a));
    expect(first.status).toBe("running");

    const second = await service.dispatch(writeRequest(b));
    expect(second.status).toBe("rejected");
    expect(second.message).toContain("write-capable");

    fake.finish({});
    await tick();
  });

  test("a workspace path escaping the root is rejected", async () => {
    const { service, agentRoot } = setup();
    const outside = path.join(agentRoot, "..", "escape-" + path.basename(agentRoot));
    const result = await service.dispatch(writeRequest(outside));
    expect(result.status).toBe("rejected");
  });
});

describe("worktree flow regression (workspace outside agent-owned roots)", () => {
  test("a git workspace outside the agent-owned roots still uses a worktree", async () => {
    const { service, fake, stateDir, agentRoot } = setup();

    // A separate repo inside the allowed roots but declared non-agent-owned.
    const repo = path.join(agentRoot, "external-repo");
    fs.mkdirSync(repo);
    git(repo, ["init"]);
    fs.writeFileSync(path.join(repo, "app.txt"), "v1\n");
    git(repo, ["add", "-A"]);
    git(repo, [
      "-c", "user.name=T", "-c", "user.email=t@e.c", "-c", "commit.gpgsign=false",
      "commit", "-m", "init",
    ]);

    // Rebuild the service with the repo allowed but NOT agent-owned.
    const service2 = new DelegationService({
      config: {
        ...service.getConfig(),
        agentOwnedRoots: [],
      },
      backends: [fake.backend],
      stateBaseDir: stateDir,
    });

    const result = await service2.dispatch(writeRequest(repo));
    expect(result.status).toBe("running");
    expect(result.message).toContain("worktree");
    // Backend cwd is the isolated worktree, not the repo.
    expect(fake.lastWorkspace!.toLowerCase()).not.toBe(repo.toLowerCase());
    expect(fake.lastWorkspace!.toLowerCase()).toContain("worktree");

    fs.writeFileSync(path.join(fake.lastWorkspace!, "new.txt"), "agent change\n");
    fake.finish({ summary: "changed in worktree" });
    await tick();

    const task = getTask(result.taskId!, stateDir)!;
    expect(task.runMode).toBe("worktree");
    // User's tree untouched; patch reported.
    expect(fs.existsSync(path.join(repo, "new.txt"))).toBe(false);
    expect(task.patchFile).toBeTruthy();
  });
});
