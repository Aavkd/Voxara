/**
 * Backend adapter tests (phase C2a — spec §15 "Backend parsing").
 * Event-parsing units plus full adapter runs against fake CLI fixtures.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseCodexEventLine, createCodexBackend } from "../src/delegation/backends/codex";
import { parseClaudeEventLine, createClaudeBackend } from "../src/delegation/backends/claude";
import { BackendRunContext, DelegationProgressEvent } from "../src/delegation/types";

const FIXTURES = path.join(__dirname, "fixtures", "delegation");

jest.setTimeout(30000);

function makeContext(
  events: DelegationProgressEvent[]
): BackendRunContext {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "voxara-artifacts-"));
  return {
    taskId: "task-test",
    workspace: FIXTURES,
    capability: "read_only",
    webResearch: false,
    timeoutMs: 20000,
    maxOutputBytes: 1024 * 1024,
    artifactDir,
    onProgress: (event) => events.push(event),
  };
}

describe("parseCodexEventLine", () => {
  test("maps thread/agent/command/error events", () => {
    expect(
      parseCodexEventLine('{"type":"thread.started","thread_id":"th_1"}').sessionId
    ).toBe("th_1");
    expect(
      parseCodexEventLine(
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
      ).agentMessage
    ).toBe("done");
    expect(
      parseCodexEventLine(
        '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}'
      ).progressText
    ).toBe("exec: ls");
    expect(parseCodexEventLine('{"type":"error","message":"boom"}').errorText).toBe(
      "boom"
    );
  });

  test("supports the legacy msg shape", () => {
    expect(
      parseCodexEventLine('{"id":"1","msg":{"type":"agent_message","message":"hi"}}')
        .agentMessage
    ).toBe("hi");
    expect(
      parseCodexEventLine(
        '{"id":"0","msg":{"type":"session_configured","session_id":"s1"}}'
      ).sessionId
    ).toBe("s1");
  });

  test("malformed lines become bounded progress, never a throw", () => {
    const parsed = parseCodexEventLine("not json at all {{{");
    expect(parsed.progressText).toContain("unparsable");
  });
});

describe("parseClaudeEventLine", () => {
  test("maps system/assistant/result events", () => {
    expect(
      parseClaudeEventLine('{"type":"system","subtype":"init","session_id":"s9"}')
        .sessionId
    ).toBe("s9");

    const assistant = parseClaudeEventLine(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"look"},{"type":"tool_use","name":"Read"}]}}'
    );
    expect(assistant.progressText).toBe("look | tool: Read");

    const result = parseClaudeEventLine(
      '{"type":"result","subtype":"success","is_error":false,"result":"report","session_id":"s9"}'
    );
    expect(result.resultText).toBe("report");
    expect(result.isErrorResult).toBe(false);
  });

  test("error results are flagged", () => {
    const result = parseClaudeEventLine(
      '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"nope"}'
    );
    expect(result.isErrorResult).toBe(true);
  });

  test("malformed lines become bounded progress, never a throw", () => {
    expect(parseClaudeEventLine("garbage").progressText).toContain("unparsable");
  });
});

describe("codex adapter against the fake CLI", () => {
  const backend = createCodexBackend({
    executablePath: path.join(FIXTURES, "fake-codex.js"),
  });

  test("detect reports the configured executable", async () => {
    const availability = await backend.detect();
    // The fake exits 0 on --version (stdin closes immediately), so it is healthy.
    expect(availability.available).toBe(true);
    expect(availability.executablePath).toContain("fake-codex.js");
  });

  test("successful run produces summary, session id, and artifacts", async () => {
    const events: DelegationProgressEvent[] = [];
    const context = makeContext(events);
    const agent = await backend.start(context, "check the tests");
    const outcome = await agent.wait;

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain("check the tests");
    expect(outcome.backendSessionId).toBe("th_fake123");
    expect(events.some((e) => e.text.startsWith("exec:"))).toBe(true);
    // Raw events are logged to the artifact dir.
    const log = fs.readFileSync(path.join(context.artifactDir, "events.jsonl"), "utf-8");
    expect(log).toContain("thread.started");
  });

  test("non-zero exit fails cleanly with a bounded diagnostic", async () => {
    const events: DelegationProgressEvent[] = [];
    const agent = await backend.start(makeContext(events), "FAIL_PLEASE now");
    const outcome = await agent.wait;

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("fake codex failure");
  });
});

describe("claude adapter against the fake CLI", () => {
  const backend = createClaudeBackend({
    executablePath: path.join(FIXTURES, "fake-claude.js"),
  });

  test("successful run produces summary and session id", async () => {
    const events: DelegationProgressEvent[] = [];
    const agent = await backend.start(makeContext(events), "audit the config");
    const outcome = await agent.wait;

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain("audit the config");
    expect(outcome.backendSessionId).toBe("sess_fakeabc");
    expect(events.some((e) => e.text.includes("tool: Read"))).toBe(true);
  });

  test("error result fails cleanly", async () => {
    const events: DelegationProgressEvent[] = [];
    const agent = await backend.start(makeContext(events), "FAIL_PLEASE now");
    const outcome = await agent.wait;

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("fake claude failure");
  });

  test("missing executable reports unavailable with setup guidance", async () => {
    const missing = createClaudeBackend({
      executablePath: path.join(FIXTURES, "no-such-cli.js"),
    });
    const availability = await missing.detect();
    expect(availability.available).toBe(false);
    expect(availability.problem).toBeDefined();
  });
});
