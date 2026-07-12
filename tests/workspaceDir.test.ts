/**
 * loadWorkspaceDir — persistent agent workspace resolution.
 *
 * The workspace replaces the old per-session `llmtest-sandbox-<timestamp>`
 * directories: one stable, configurable directory shared by the agent file
 * tools and, later, delegated coding agents.
 */

import * as os from "os";
import * as path from "path";
import { loadWorkspaceDir } from "../src/config/loader";

describe("loadWorkspaceDir", () => {
  const ORIGINAL_ENV = process.env.LLMTEST_WORKSPACE_DIR;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.LLMTEST_WORKSPACE_DIR;
    } else {
      process.env.LLMTEST_WORKSPACE_DIR = ORIGINAL_ENV;
    }
  });

  it("defaults to ~/.llmtest/workspace when unset", () => {
    delete process.env.LLMTEST_WORKSPACE_DIR;
    expect(loadWorkspaceDir()).toBe(
      path.join(os.homedir(), ".llmtest", "workspace")
    );
  });

  it("uses LLMTEST_WORKSPACE_DIR when set", () => {
    const custom = path.join(os.tmpdir(), "voxara-workspace");
    process.env.LLMTEST_WORKSPACE_DIR = custom;
    expect(loadWorkspaceDir()).toBe(path.resolve(custom));
  });

  it("resolves relative paths against the current directory", () => {
    process.env.LLMTEST_WORKSPACE_DIR = "./my-workspace";
    expect(loadWorkspaceDir()).toBe(path.resolve("./my-workspace"));
  });

  it("treats a blank value as unset", () => {
    process.env.LLMTEST_WORKSPACE_DIR = "   ";
    expect(loadWorkspaceDir()).toBe(
      path.join(os.homedir(), ".llmtest", "workspace")
    );
  });
});
