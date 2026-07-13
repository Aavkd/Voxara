/**
 * Browser bridge — localhost WebSocket server the Chrome extension connects
 * OUT to (decision D4: no CDP, no managed browser, no native messaging).
 *
 * Phase C3b (docs/phase-c3-computer-control.md §7.1–§7.2). The server binds
 * to 127.0.0.1 only; the first frame of a connection must be a `hello`
 * carrying the pairing token, and any mismatch closes the socket. Requests
 * are JSON with correlation ids, one in-flight map, per-request timeout.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { WebSocket, WebSocketServer } from "ws";
import { loadControlBridgePort } from "../config/loader";
import { ensureStateDir } from "../engine/statePaths";
import { BridgeCommand, BridgeResponse } from "./types";

const HELLO_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const KEEPALIVE_INTERVAL_MS = 20000;

/** Guidance relayed verbatim when no extension is paired/connected (§7.3). */
export const EXTENSION_NOT_CONNECTED_MESSAGE =
  "l'extension Chrome n'est pas connectée — `llmtest control doctor` explique l'appairage";

/**
 * Pairing token: generated on first need, stored under the C2 state root,
 * shown by `llmtest control doctor`, pasted once into the extension options.
 */
export function getOrCreateBridgeToken(baseDir?: string): string {
  const state = ensureStateDir(baseDir);
  const controlDir = path.join(state.root, "control");
  fs.mkdirSync(controlDir, { recursive: true });
  const tokenFile = path.join(controlDir, "bridge-token");
  if (fs.existsSync(tokenFile)) {
    const existing = fs.readFileSync(tokenFile, "utf8").trim();
    if (existing.length >= 16) {
      return existing;
    }
  }
  const token = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(tokenFile, token, "utf8");
  return token;
}

export interface BrowserBridgeOptions {
  /** Defaults to CONTROL_BRIDGE_PORT (7863). Use 0 in tests for an ephemeral port. */
  port?: number;
  /** Defaults to the persisted pairing token. */
  token?: string;
  requestTimeoutMs?: number;
  /** State-root override for the token file (tests). */
  baseDir?: string;
}

interface InFlightRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class BrowserBridge {
  private readonly options: BrowserBridgeOptions;
  private server?: WebSocketServer;
  private extension?: WebSocket;
  private extensionVersion?: string;
  private readonly inFlight = new Map<string, InFlightRequest>();
  private keepalive?: NodeJS.Timeout;
  private startPromise?: Promise<void>;
  private resolvedToken?: string;

  constructor(options: BrowserBridgeOptions = {}) {
    this.options = options;
  }

  get token(): string {
    if (!this.resolvedToken) {
      this.resolvedToken =
        this.options.token ?? getOrCreateBridgeToken(this.options.baseDir);
    }
    return this.resolvedToken;
  }

  /** The actual bound port (meaningful after start(), esp. with port 0). */
  get port(): number | undefined {
    const address = this.server?.address();
    if (address && typeof address === "object") {
      return address.port;
    }
    return this.options.port ?? loadControlBridgePort();
  }

  isListening(): boolean {
    return this.server !== undefined;
  }

  isExtensionConnected(): boolean {
    return this.extension?.readyState === WebSocket.OPEN;
  }

  getExtensionVersion(): string | undefined {
    return this.isExtensionConnected() ? this.extensionVersion : undefined;
  }

  /** Idempotent: concurrent callers share one listen attempt. */
  start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.listen().catch((err) => {
        this.startPromise = undefined;
        throw err;
      });
    }
    return this.startPromise;
  }

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const port = this.options.port ?? loadControlBridgePort();
      const server = new WebSocketServer({ host: "127.0.0.1", port });

      server.once("listening", () => {
        this.server = server;
        this.keepalive = setInterval(() => {
          if (this.isExtensionConnected()) {
            // App-level ping: WS traffic keeps the MV3 service worker alive.
            this.extension?.send(JSON.stringify({ type: "ping" }));
          }
        }, KEEPALIVE_INTERVAL_MS);
        this.keepalive.unref?.();
        resolve();
      });
      server.once("error", (err) => {
        reject(
          new Error(
            `control bridge failed to listen on 127.0.0.1:${port}: ${err.message}`
          )
        );
      });
      server.on("connection", (socket) => this.handleConnection(socket));
    });
  }

  private handleConnection(socket: WebSocket): void {
    // The first frame must be a hello with the pairing token (§7.1).
    const helloTimer = setTimeout(() => {
      socket.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    socket.once("message", (data) => {
      clearTimeout(helloTimer);
      let hello: { type?: string; token?: string; extensionVersion?: string };
      try {
        hello = JSON.parse(String(data));
      } catch {
        socket.close(4002, "invalid hello");
        return;
      }
      if (hello.type !== "hello" || !hello.token || !timingSafeEquals(hello.token, this.token)) {
        socket.close(4003, "pairing token mismatch");
        return;
      }

      // Latest valid connection wins (extension restarts, SW respawns).
      if (this.extension && this.extension !== socket) {
        this.extension.close(4000, "replaced by a newer connection");
      }
      this.extension = socket;
      this.extensionVersion = hello.extensionVersion;

      socket.on("message", (frame) => this.handleFrame(frame));
      socket.on("close", () => {
        if (this.extension === socket) {
          this.extension = undefined;
          this.failAllInFlight(new Error("the Chrome extension disconnected mid-request"));
        }
      });
      socket.on("error", () => {
        // close follows; nothing to do beyond preventing an unhandled 'error'.
      });
    });
  }

  private handleFrame(data: unknown): void {
    let message: BridgeResponse & { type?: string };
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === "pong") {
      return;
    }
    const pending = message.id ? this.inFlight.get(message.id) : undefined;
    if (!pending) {
      return;
    }
    this.inFlight.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || "the extension reported an unspecified error"));
    }
  }

  /**
   * Send one command to the connected extension and await its correlated
   * response. Fails fast with user-relayable guidance when no extension is
   * connected (§7.3).
   */
  request<T = unknown>(
    command: BridgeCommand,
    params: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<T> {
    if (!this.isExtensionConnected()) {
      return Promise.reject(new Error(EXTENSION_NOT_CONNECTED_MESSAGE));
    }
    const id = crypto.randomUUID();
    const budget = timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inFlight.delete(id);
        reject(new Error(`the browser extension did not answer "${command}" within ${budget} ms`));
      }, budget);
      timer.unref?.();
      this.inFlight.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.extension!.send(JSON.stringify({ id, command, params }));
    });
  }

  private failAllInFlight(error: Error): void {
    for (const [id, pending] of this.inFlight) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.inFlight.delete(id);
    }
  }

  async stop(): Promise<void> {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = undefined;
    }
    this.failAllInFlight(new Error("control bridge stopped"));
    this.extension?.close(1001, "bridge shutting down");
    this.extension = undefined;
    const server = this.server;
    this.server = undefined;
    this.startPromise = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => resolve());
      });
    }
  }
}

// ── Process-wide singleton ───────────────────────────────────────────

let bridgeSingleton: BrowserBridge | undefined;

export function getBrowserBridge(): BrowserBridge {
  if (!bridgeSingleton) {
    bridgeSingleton = new BrowserBridge();
  }
  return bridgeSingleton;
}

/**
 * Start the bridge for a session whose active tools include browser control.
 * Fire-and-forget and error-tolerant: a busy port degrades to a console
 * warning — the browser tools then fail fast per call with guidance.
 */
export function ensureControlBridgeStarted(toolNames: string[]): void {
  const controlTools = ["browser_read", "browser_act", "screen_view"];
  if (!toolNames.some((name) => controlTools.includes(name))) {
    return;
  }
  getBrowserBridge()
    .start()
    .catch((err: unknown) => {
      console.warn(
        `[control] browser bridge unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    });
}

function timingSafeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}
