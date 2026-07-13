/**
 * control command — computer-control diagnostics and extension pairing.
 *
 * Phase C3b (docs/phase-c3-computer-control.md §7.1):
 *   llmtest control doctor   config, pairing token, and live extension check
 */

import { Command } from "commander";
import {
  loadControlBridgePort,
  loadControlMaxSnapshotChars,
  loadControlTrustLevel,
  loadVoiceConfig,
} from "../config/loader";
import { BrowserBridge, getOrCreateBridgeToken } from "../control/browserBridge";

const CONNECT_WAIT_MS = 6000;

export function controlCommand(): Command {
  const command = new Command("control");
  command.description("Inspect and pair the computer-control channels (phase C3)");

  command
    .command("doctor")
    .description("Show control configuration, the extension pairing token, and connection status")
    .action(async () => {
      loadVoiceConfig(); // load .env files before reading control config

      const port = loadControlBridgePort();
      const token = getOrCreateBridgeToken();

      console.log("Computer control configuration");
      console.log(`  Trust level:        ${loadControlTrustLevel()} (CONTROL_TRUST_LEVEL)`);
      console.log(`  Bridge port:        127.0.0.1:${port} (CONTROL_BRIDGE_PORT)`);
      console.log(`  Snapshot budget:    ${loadControlMaxSnapshotChars()} chars (CONTROL_MAX_SNAPSHOT_CHARS)`);
      console.log("");
      console.log("Chrome extension pairing");
      console.log(`  Pairing token:      ${token}`);
      console.log("  Steps:");
      console.log("    1. chrome://extensions → enable Developer mode → Load unpacked → select the repo's extension/ folder");
      console.log("    2. Open the extension's Options page and paste the token (and the port if not 7863)");
      console.log("    3. Keep a Voxara session running (voice-chat --agent or agent-chat) — the extension connects to it");
      console.log("");

      // Live check: listen briefly; the extension reconnects with backoff, so
      // a few seconds are enough to see it when Chrome is open and paired.
      const bridge = new BrowserBridge({ port, token });
      try {
        await bridge.start();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/EADDRINUSE|failed to listen/i.test(message)) {
          console.log(
            "Bridge port already in use — a Voxara session is likely running and owns the bridge. " +
              "That is the normal live setup."
          );
        } else {
          console.error(`Bridge check failed: ${message}`);
        }
        return;
      }

      process.stdout.write(`Waiting up to ${CONNECT_WAIT_MS / 1000}s for the extension to connect... `);
      const connected = await waitForConnection(bridge, CONNECT_WAIT_MS);
      if (connected) {
        console.log(`OK — extension v${bridge.getExtensionVersion() ?? "?"} connected.`);
      } else {
        console.log("not connected.");
        console.log(
          "  Check that Chrome is open, the extension is loaded, and the token/port in its options match the above."
        );
      }
      await bridge.stop();
    });

  return command;
}

async function waitForConnection(bridge: BrowserBridge, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (bridge.isExtensionConnected()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return bridge.isExtensionConnected();
}
