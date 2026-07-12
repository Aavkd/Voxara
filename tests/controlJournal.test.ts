import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { journalScreenView } from "../src/control/journal";

test("screen journal retains only the five newest capture artifacts", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "voxara-control-"));
  const image = {
    kind: "image" as const,
    mimeType: "image/png" as const,
    base64: "aW1hZ2U=",
  };
  try {
    for (let index = 0; index < 7; index += 1) {
      journalScreenView(
        { sessionId: "session-test", target: "screen", outcome: "success" },
        image,
        stateDir
      );
    }

    const controlDir = path.join(stateDir, "control");
    const captures = fs.readdirSync(path.join(controlDir, "session-test", "captures"));
    const records = fs.readFileSync(path.join(controlDir, "session-test.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(captures).toHaveLength(5);
    expect(records).toHaveLength(7);
    expect(records.every((record) => record.policyDecision === "allowed")).toBe(true);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
