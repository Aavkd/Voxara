/**
 * Fake Codex CLI for adapter tests. Reads the task from stdin, emits
 * representative `codex exec --json` JSONL events, and exits 0 — or fails
 * when the task contains FAIL_PLEASE.
 */
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString();
});
process.stdin.on("end", () => {
  const task = input.trim();
  console.log(JSON.stringify({ type: "thread.started", thread_id: "th_fake123" }));

  if (task.includes("FAIL_PLEASE")) {
    console.log(JSON.stringify({ type: "error", message: "fake codex failure" }));
    process.exit(2);
    return;
  }

  console.log(
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "dir /b" },
    })
  );
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: `Analysis complete for: ${task}` },
    })
  );
  process.exit(0);
});
