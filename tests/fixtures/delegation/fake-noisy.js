/**
 * Fake noisy process: floods stdout to exercise the output byte cap.
 */
const line = "x".repeat(1024);
for (let i = 0; i < 200; i++) {
  console.log(`${i} ${line}`);
}
process.exit(0);
