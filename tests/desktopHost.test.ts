import * as path from "path";
import { DESKTOP_HOST_SCRIPT, DesktopHost } from "../src/control/desktopHost";

const FAKE = path.join(__dirname, "fixtures", "fakeDesktopHost.js");

function nodeHost(requestTimeoutMs = 3000): DesktopHost {
  return new DesktopHost({
    spawnOverride: { command: process.execPath, args: [FAKE] },
    requestTimeoutMs,
  });
}

describe("desktop host (stdio JSON-line protocol)", () => {
  test("launch captures a newly added top-level window instead of the child MainWindowHandle", () => {
    const start = DESKTOP_HOST_SCRIPT.indexOf("function Launch-App");
    const end = DESKTOP_HOST_SCRIPT.indexOf("function Get-IdleMs", start);
    const launchScript = DESKTOP_HOST_SCRIPT.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(launchScript).toContain("$beforeHandles");
    expect(launchScript).toContain("Get-TopWindows");
    expect(launchScript).toContain("$newWindows");
    expect(launchScript).toContain("$candidateStablePolls");
    expect(launchScript).toContain("$candidateStablePolls -ge 8");
    expect(launchScript).not.toContain("$proc.MainWindowHandle");
  });

  test("correlates concurrent requests to their responses", async () => {
    const host = nodeHost();
    try {
      const [pong, echo] = await Promise.all([
        host.request<string>("ping"),
        host.request<{ v: number }>("echo", { v: 42 }),
      ]);
      expect(pong).toBe("pong");
      expect(echo).toEqual({ v: 42 });
    } finally {
      await host.stop();
    }
  });

  test("rejects a request the helper reports as failed", async () => {
    const host = nodeHost();
    try {
      await expect(host.request("boom")).rejects.toThrow("kaboom");
    } finally {
      await host.stop();
    }
  });

  test("times out a request the helper never answers", async () => {
    const host = nodeHost(300);
    try {
      await expect(host.request("hang")).rejects.toThrow(/within 300 ms/);
    } finally {
      await host.stop();
    }
  });

  test("respawns after the helper exits, bumping the generation (refs go stale)", async () => {
    const host = nodeHost();
    try {
      await host.request("ping");
      const firstGen = host.generation;

      // The helper exits; the in-flight/next request must fail, then respawn.
      await host.request("exit").catch(() => undefined);
      // Give the close event a tick to land.
      await new Promise((r) => setTimeout(r, 50));

      const pong = await host.request<string>("ping");
      expect(pong).toBe("pong");
      expect(host.generation).toBeGreaterThan(firstGen);
    } finally {
      await host.stop();
    }
  });

  test("interrupt fails in-flight work and lets the next request respawn", async () => {
    const host = nodeHost(5000);
    try {
      const pending = host.request("hang");
      await new Promise((r) => setTimeout(r, 20));
      await host.interrupt();
      await expect(pending).rejects.toThrow(/interrupted/);
      // A fresh request works again.
      await expect(host.request<string>("ping")).resolves.toBe("pong");
    } finally {
      await host.stop();
    }
  });
});
