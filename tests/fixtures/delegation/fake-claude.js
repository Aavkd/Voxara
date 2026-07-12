/**
 * Fake Claude Code CLI for adapter tests. Reads the task from stdin, emits
 * representative stream-JSON events, and exits 0 — or fails when the task
 * contains FAIL_PLEASE.
 */
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString();
});
process.stdin.on("end", () => {
  const task = input.trim();
  console.log(
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess_fakeabc" })
  );

  if (task.includes("FAIL_PLEASE")) {
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "fake claude failure",
        session_id: "sess_fakeabc",
      })
    );
    process.exit(1);
    return;
  }

  console.log(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Scanning the workspace" },
          { type: "tool_use", name: "Read" },
        ],
      },
    })
  );
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `Report for: ${task}`,
      session_id: "sess_fakeabc",
    })
  );
  process.exit(0);
});
