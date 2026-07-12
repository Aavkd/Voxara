/**
 * Fake hanging process: prints one line, then stays alive until killed.
 * Used for timeout and cancellation (process-tree kill) tests.
 */
console.log("hanging");
setInterval(() => undefined, 1000);
