// Hard wall-clock cap on `vitest run`. Per-test/hook/teardown timeouts (vite.config.ts)
// fail a single hung await, but a leaked timer/open handle can stall a worker so files sit
// [queued] forever with no failure. This caps the whole run so it can never hang indefinitely.
// Override the cap with VITEST_RUN_CAP_MS. Extra args are forwarded (e.g. npm test -- src/x.test.ts).
import { spawn } from "node:child_process";

const CAP_MS = Number(process.env.VITEST_RUN_CAP_MS ?? 6 * 60 * 1000);
const args = process.argv.slice(2);
const child = spawn("npx", ["vitest", "run", ...args], { stdio: "inherit" });

const timer = setTimeout(() => {
  console.error(
    `\n[test-cap] vitest run exceeded ${CAP_MS}ms and was killed — a test is hanging ` +
      `(likely a leaked timer/open handle). Failing the run.`,
  );
  child.kill("SIGKILL");
  process.exit(1);
}, CAP_MS);
timer.unref();

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (signal) {
    console.error(`[test-cap] vitest terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
child.on("error", (err) => {
  clearTimeout(timer);
  console.error(`[test-cap] failed to start vitest: ${err.message}`);
  process.exit(1);
});
