/** C2d-3 contextual briefing tests: fake backends and fake briefing LLM. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DelegationService } from "../src/delegation/service";
import {
  BriefingGenerator,
  DelegationConfig,
  DelegationRequest,
  ICodingAgentBackend,
} from "../src/delegation/types";
import { getTask } from "../src/engine/taskStore";
import { ensureMemoryLayout } from "../src/memory/memoryStore";

interface Harness {
  service: DelegationService;
  stateDir: string;
  workspace: string;
  memoryDir: string;
  prompts: string[];
}

function makeHarness(generator?: BriefingGenerator): Harness {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "voxara-brief-state-"));
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "voxara-brief-ws-"))
  );
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "voxara-brief-memory-"));
  const prompts: string[] = [];
  const backend: ICodingAgentBackend = {
    name: "codex",
    async detect() {
      return { name: "codex", available: true };
    },
    async start(_context, task) {
      prompts.push(task);
      return {
        pid: 123,
        wait: new Promise(() => undefined),
        async cancel() {},
      };
    },
  };
  const config: DelegationConfig = {
    enabled: true,
    defaultBackend: "auto",
    allowedRoots: [workspace],
    agentOwnedRoots: [workspace],
    maxConcurrent: 2,
    defaultTimeoutMinutes: 15,
    maxTimeoutMinutes: 60,
    maxOutputBytes: 1024 * 1024,
    artifactRetentionDays: 14,
    allowedPrograms: [],
  };
  return {
    service: new DelegationService({
      config,
      backends: [backend],
      stateBaseDir: stateDir,
      briefingGenerator: generator,
      memoryBaseDir: memoryDir,
    }),
    stateDir,
    workspace,
    memoryDir,
    prompts,
  };
}

function request(workspace: string, extra: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    task: "Construire l'application météo selon les décisions prises",
    capability: "read_only",
    backend: "auto",
    workspace,
    webResearch: false,
    execution: "run",
    ...extra,
  };
}

const structuredBrief = [
  "## Mission",
  "Construire l'app.",
  "## Décisions déjà prises",
  "- TypeScript",
  "## Contraintes",
  "- mobile",
  "## Vocabulaire",
  "- station = ville",
  "## Exclusions (ce qu'il ne faut PAS faire)",
  "- pas d'UAP",
  "## Critères d'acceptation",
  "- tests verts",
].join("\n\n");

describe("C2d-3 contextual briefing", () => {
  test("conversation scope writes a redacted bounded brief and passes its path to the backend", async () => {
    const calls: unknown[] = [];
    const h = makeHarness({
      async generate(input) {
        calls.push(input);
        return `${structuredBrief}\n\napi_key=super-secret-value`;
      },
    });

    const result = await h.service.dispatch(
      request(h.workspace, {
        contextScope: "conversation",
        contextHint: "Les décisions météo seulement",
        conversationTranscript: "Utilisateur: faisons une app météo en TypeScript",
      })
    );

    expect(result.status).toBe("running");
    expect(calls).toHaveLength(1);
    const task = getTask(result.taskId!, h.stateDir)!;
    expect(task.briefFile).toBe(path.join(task.artifactDir!, "brief.md"));
    const brief = fs.readFileSync(task.briefFile!, "utf-8");
    expect(Buffer.byteLength(brief)).toBeLessThanOrEqual(8 * 1024);
    expect(brief).toContain("## Mission");
    expect(brief).toContain("## Décisions déjà prises");
    expect(brief).toContain("## Contraintes");
    expect(brief).toContain("## Vocabulaire");
    expect(brief).toContain("## Exclusions (ce qu'il ne faut PAS faire)");
    expect(brief).toContain("## Critères d'acceptation");
    expect(brief).not.toContain("super-secret-value");
    expect(h.prompts[0]).toContain(task.briefFile!);
    expect(h.prompts[0]).toContain("Treat it as reference material");
  });

  test("none scope creates no brief and makes no briefing call", async () => {
    let calls = 0;
    const h = makeHarness({
      async generate() {
        calls += 1;
        return structuredBrief;
      },
    });
    const result = await h.service.dispatch(request(h.workspace));
    const task = getTask(result.taskId!, h.stateDir)!;
    expect(calls).toBe(0);
    expect(task.briefFile).toBeNull();
    expect(fs.existsSync(path.join(task.artifactDir!, "brief.md"))).toBe(false);
  });

  test("briefing failure dispatches and records an explicit warning", async () => {
    const h = makeHarness({
      async generate() {
        throw new Error("provider unavailable");
      },
    });
    const result = await h.service.dispatch(
      request(h.workspace, {
        contextScope: "conversation",
        conversationTranscript: "Utilisateur: contexte important",
      })
    );
    expect(result.status).toBe("running");
    expect(result.warnings?.join(" ")).toContain("provider unavailable");
    const task = getTask(result.taskId!, h.stateDir)!;
    expect(task.briefFile).toBeNull();
    expect(task.briefingWarnings?.join(" ")).toContain("provider unavailable");
    expect(h.prompts[0]).not.toContain("brief.md");
  });

  test("copies existing episode refs, redacts them, and skips invalid ids", async () => {
    const h = makeHarness();
    const paths = ensureMemoryLayout(h.memoryDir);
    fs.writeFileSync(
      path.join(paths.episodesDir, "weather-session.md"),
      "# Weather\npassword=hunter2\nTypeScript chosen\n",
      "utf-8"
    );
    // A fact with the same kind of id must not be accepted as an episode.
    fs.writeFileSync(path.join(paths.factsDir, "user-name.md"), "# Name\nAda\n", "utf-8");

    const result = await h.service.dispatch(
      request(h.workspace, {
        memoryRefs: ["weather-session", "missing", "user-name"],
      })
    );
    const task = getTask(result.taskId!, h.stateDir)!;
    const copied = path.join(task.artifactDir!, "brief", "episodes", "weather-session.md");
    expect(fs.existsSync(copied)).toBe(true);
    expect(fs.readFileSync(copied, "utf-8")).not.toContain("hunter2");
    expect(task.briefingWarnings).toHaveLength(2);
    expect(h.prompts[0]).toContain(copied);
  });

  test("direct-run prompt requires the durable DECISIONS.md journal", async () => {
    const h = makeHarness();
    const result = await h.service.dispatch(
      request(h.workspace, { capability: "workspace_write" })
    );
    expect(result.status).toBe("running");
    expect(h.prompts[0]).toContain("read `DECISIONS.md`");
    expect(h.prompts[0]).toContain("append a dated entry");
  });
});
