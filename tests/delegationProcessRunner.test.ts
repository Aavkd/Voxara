/**
 * Supervised process-runner tests (phase C2a — spec §15 "Process runner").
 * Uses real Node child processes running the fake fixture scripts.
 */

import * as path from "path";
import { runSupervisedProcess } from "../src/delegation/processRunner";

const FIXTURES = path.join(__dirname, "fixtures", "delegation");
const fixture = (name: string): string => path.join(FIXTURES, name);

jest.setTimeout(30000);

describe("runSupervisedProcess", () => {
  test("runs a .js executable via node with argument-array invocation", async () => {
    const lines: string[] = [];
    const proc = runSupervisedProcess({
      executable: fixture("fake-codex.js"),
      args: [],
      cwd: FIXTURES,
      stdin: "hello world",
      timeoutMs: 15000,
      maxOutputBytes: 1024 * 1024,
      onStdoutLine: (line) => lines.push(line),
    });
    const outcome = await proc.wait;

    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.error).toBeUndefined();
    // stdin reached the child untouched — no shell interpolation happened.
    expect(lines.join("\n")).toContain("hello world");
  });

  test("missing executable yields a bounded error outcome, not a crash", async () => {
    const proc = runSupervisedProcess({
      executable: "definitely-not-a-real-binary-xyz",
      args: [],
      cwd: FIXTURES,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    const outcome = await proc.wait;
    expect(outcome.error).toBeDefined();
  });

  test("output beyond the byte cap is truncated", async () => {
    let bytes = 0;
    const proc = runSupervisedProcess({
      executable: fixture("fake-noisy.js"),
      args: [],
      cwd: FIXTURES,
      timeoutMs: 15000,
      maxOutputBytes: 8 * 1024, // fixture emits ~200 KB
      onStdoutLine: (line) => {
        bytes += line.length;
      },
    });
    const outcome = await proc.wait;
    expect(outcome.stdoutTruncated).toBe(true);
    expect(bytes).toBeLessThan(64 * 1024);
  });

  test("timeout kills a hanging process", async () => {
    const proc = runSupervisedProcess({
      executable: fixture("fake-hang.js"),
      args: [],
      cwd: FIXTURES,
      timeoutMs: 1500,
      maxOutputBytes: 1024,
    });
    const outcome = await proc.wait;
    expect(outcome.timedOut).toBe(true);
  });

  test("cancel terminates the process tree and resolves", async () => {
    const lines: string[] = [];
    const proc = runSupervisedProcess({
      executable: fixture("fake-hang.js"),
      args: [],
      cwd: FIXTURES,
      timeoutMs: 60000,
      maxOutputBytes: 1024,
      onStdoutLine: (line) => lines.push(line),
    });

    // Give it a moment to actually start.
    await new Promise((resolve) => setTimeout(resolve, 700));
    await proc.cancel();

    const outcome = await proc.wait;
    expect(outcome.cancelled).toBe(true);
    expect(proc.pid).toBeDefined();
  });
});
