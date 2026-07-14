/**
 * Fake desktop host for tests — mimics the PowerShell helper's stdio JSON-line
 * protocol (one request per stdin line, one response per stdout line) without
 * any Windows dependency. Behaviors are keyed by command so tests can exercise
 * correlation, restart, and timeouts.
 */
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, command, params = {} } = req;

  const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

  if (command === "ping") {
    send({ id, ok: true, result: "pong" });
    return;
  }
  if (command === "echo") {
    send({ id, ok: true, result: params });
    return;
  }
  if (command === "boom") {
    send({ id, ok: false, error: "kaboom" });
    return;
  }
  if (command === "hang") {
    // Never respond — the client's per-request timeout must fire.
    return;
  }
  if (command === "exit") {
    process.exit(0);
    return;
  }
  send({ id, ok: false, error: `unknown command ${command}` });
});
