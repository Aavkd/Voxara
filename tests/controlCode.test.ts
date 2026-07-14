import { resetControlSessionGrants } from "../src/control/policy";
import { BrowserExecutor } from "../src/control/executor";
import { ProcessOutcome } from "../src/delegation/processRunner";
import { createControlCodeTool } from "../src/providers/tools/controlCode";

const okOutcome: ProcessOutcome = {
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  stdoutTruncated: false,
  stderrTruncated: false,
};

function fakeBrowserExecutor(execJs: BrowserExecutor["execJs"]): BrowserExecutor {
  return {
    readPage: async () => ({ url: "https://a", title: "A", elements: [] }),
    listTabs: async () => [],
    act: async () => ({}),
    screenshot: async () => ({ kind: "image", mimeType: "image/png", base64: "x" }),
    execJs,
    lookupRef: () => undefined,
    isAvailable: () => true,
  };
}

describe("control_code tool", () => {
  beforeEach(() => resetControlSessionGrants());

  test("requires code and rationale", async () => {
    const tool = createControlCodeTool({ journal: jest.fn(), trustLevel: () => "auto" });
    await expect(tool.execute({ language: "powershell", code: "", rationale: "x" }, "."))
      .resolves.toMatch(/requires non-empty code/);
    await expect(tool.execute({ language: "powershell", code: "Get-Date", rationale: "" }, "."))
      .resolves.toMatch(/requires a rationale/);
  });

  test("is always confirmed under session_grant, relaying the rationale", async () => {
    const run = jest.fn();
    const tool = createControlCodeTool({
      journal: jest.fn(),
      trustLevel: () => "session_grant",
      runPowerShell: run,
    });
    const blocked = await tool.execute(
      { language: "powershell", code: "Remove-Item x", rationale: "supprime le fichier x" },
      ".",
      { sessionId: "s1" }
    );
    expect(String(blocked)).toMatch(/^action_blocked \(needs_confirmation\)/);
    expect(String(blocked)).toContain("supprime le fichier x");
    expect(run).not.toHaveBeenCalled();
  });

  test("stays confirmed under auto unless CONTROL_CODE_AUTO is set", async () => {
    const run = jest.fn(async () => ({ stdout: "hi\n", stderr: "", outcome: okOutcome }));
    const blocked = await createControlCodeTool({
      journal: jest.fn(),
      trustLevel: () => "auto",
      controlCodeAuto: () => false,
      runPowerShell: run,
    }).execute({ language: "powershell", code: "echo hi", rationale: "print" }, ".", { sessionId: "s" });
    expect(String(blocked)).toMatch(/action_blocked/);

    const allowed = await createControlCodeTool({
      journal: jest.fn(),
      trustLevel: () => "auto",
      controlCodeAuto: () => true,
      runPowerShell: run,
    }).execute({ language: "powershell", code: "echo hi", rationale: "print" }, ".", { sessionId: "s" });
    expect(String(allowed)).toContain("hi");
  });

  test("runs powershell with trusted runtime approval and formats stdout/exit code", async () => {
    const run = jest.fn(async (code: string) => ({
      stdout: `ran: ${code}\n`,
      stderr: "",
      outcome: okOutcome,
    }));
    const journal = jest.fn();
    const result = await createControlCodeTool({
      journal,
      trustLevel: () => "session_grant",
      runPowerShell: run,
    }).execute(
      { language: "powershell", code: "Get-Date", rationale: "date" },
      ".",
      { sessionId: "s2", controlApproved: true }
    );
    expect(run).toHaveBeenCalledWith("Get-Date");
    expect(String(result)).toContain("exit code: 0");
    expect(String(result)).toContain("ran: Get-Date");
    expect(journal).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "control_code:powershell", outcome: "success" })
    );
  });

  test("browser_js runs through the extension on a confirmed retry", async () => {
    const execJs = jest.fn(async () => ({ value: "3" }));
    const result = await createControlCodeTool({
      journal: jest.fn(),
      trustLevel: () => "auto",
      controlCodeAuto: () => true,
      browserExecutor: () => fakeBrowserExecutor(execJs),
    }).execute(
      { language: "browser_js", code: "return 1+2", rationale: "compute" },
      ".",
      { sessionId: "s3" }
    );
    expect(execJs).toHaveBeenCalledWith("return 1+2");
    expect(String(result)).toContain("3");
  });

  test("journals the code text even when blocked", async () => {
    const journal = jest.fn();
    await createControlCodeTool({ journal, trustLevel: () => "session_grant" }).execute(
      { language: "powershell", code: "danger", rationale: "why" },
      ".",
      { sessionId: "s4" }
    );
    expect(journal).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "control_code:powershell",
        outcome: "blocked",
        target: expect.stringContaining("danger"),
      })
    );
  });
});
