import { captureScreen } from "../src/control/screenCapture";

describe("screen capture", () => {
  test("passes an un-interpolated window title and max edge through the environment", async () => {
    let encoded = "";
    let seenEnv: NodeJS.ProcessEnv = {};
    const result = await captureScreen(
      {
        target: "window",
        windowTitle: "Bob's $(dangerous) window",
        maxEdge: 1200,
      },
      {
        platform: "win32",
        runPowerShell: async (command, env) => {
          encoded = command;
          seenEnv = env;
          return "aGVsbG8=";
        },
      }
    );

    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).not.toContain("Bob's $(dangerous) window");
    expect(seenEnv.VOXARA_WINDOW_TITLE).toBe("Bob's $(dangerous) window");
    expect(seenEnv.VOXARA_MAX_EDGE).toBe("1200");
    expect(result).toEqual({ kind: "image", mimeType: "image/png", base64: "aGVsbG8=" });
  });

  test("rejects unsupported platforms cleanly", async () => {
    await expect(captureScreen({ target: "screen" }, { platform: "linux" }))
      .rejects.toThrow("Windows only");
  });
});
