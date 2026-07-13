import { WebSocket } from "ws";
import { BrowserBridge, EXTENSION_NOT_CONNECTED_MESSAGE } from "../src/control/browserBridge";

const TOKEN = "test-pairing-token-0123456789";

/** Fake extension: a plain ws client driven by the test. */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

async function waitFor(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

describe("browser bridge", () => {
  let bridge: BrowserBridge;

  beforeEach(async () => {
    bridge = new BrowserBridge({ port: 0, token: TOKEN, requestTimeoutMs: 300 });
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
  });

  test("rejects a connection whose hello token mismatches", async () => {
    const socket = await connectClient(bridge.port!);
    socket.send(JSON.stringify({ type: "hello", token: "wrong-token-000000000000" }));
    const code = await waitForClose(socket);
    expect(code).toBe(4003);
    expect(bridge.isExtensionConnected()).toBe(false);
  });

  test("accepts a valid hello and serves a request round-trip", async () => {
    const socket = await connectClient(bridge.port!);
    socket.send(JSON.stringify({ type: "hello", token: TOKEN, extensionVersion: "0.1.0" }));
    await waitFor(() => bridge.isExtensionConnected());
    expect(bridge.getExtensionVersion()).toBe("0.1.0");

    socket.on("message", (data) => {
      const request = JSON.parse(String(data));
      if (request.command === "tabs") {
        socket.send(JSON.stringify({
          id: request.id,
          ok: true,
          result: [{ id: 1, title: "YouTube", url: "https://youtube.com", active: true }],
        }));
      }
    });

    const tabs = await bridge.request<Array<{ title: string }>>("tabs", { op: "list" });
    expect(tabs[0].title).toBe("YouTube");
    socket.close();
  });

  test("relays an extension-reported error as a rejection", async () => {
    const socket = await connectClient(bridge.port!);
    socket.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await waitFor(() => bridge.isExtensionConnected());

    socket.on("message", (data) => {
      const request = JSON.parse(String(data));
      socket.send(JSON.stringify({ id: request.id, ok: false, error: "stale ref e9" }));
    });

    await expect(bridge.request("act", { ref: "e9", action: "click" }))
      .rejects.toThrow("stale ref e9");
    socket.close();
  });

  test("fails fast with pairing guidance when no extension is connected", async () => {
    await expect(bridge.request("snapshot")).rejects.toThrow(EXTENSION_NOT_CONNECTED_MESSAGE);
  });

  test("times out a request the extension never answers", async () => {
    const socket = await connectClient(bridge.port!);
    socket.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await waitFor(() => bridge.isExtensionConnected());

    await expect(bridge.request("snapshot")).rejects.toThrow(/did not answer "snapshot"/);
    socket.close();
  });

  test("fails in-flight requests when the extension disconnects", async () => {
    const socket = await connectClient(bridge.port!);
    socket.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await waitFor(() => bridge.isExtensionConnected());

    const pending = bridge.request("snapshot", {}, 5000);
    socket.close();
    await expect(pending).rejects.toThrow("disconnected mid-request");
    await waitFor(() => !bridge.isExtensionConnected());
  });
});
