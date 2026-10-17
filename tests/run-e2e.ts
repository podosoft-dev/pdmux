import { spawnSync } from "node:child_process";
import { e2eRuns } from "./playwright.extensions";

// Runs the suite with the arguments it is given, such as `--grep` or a file.
// With E2E_WORKERS above 1, Playwright runs twice: the tests not tagged
// @exclusive on that many workers, then the tagged ones on one worker. The
// second run starts even when the first one failed, so a failing test cannot
// hide the exclusive tests, and the exit code is that of the first failed run.
const runs = e2eRuns(process.argv.slice(2));
let status = 0;
for (const run of runs) {
  if (run.phase) {
    console.log(
      run.phase === "shared"
        ? "\nRunning the tests not tagged @exclusive\n"
        : "\nRunning the tests tagged @exclusive on one worker (report: playwright-report/exclusive)\n",
    );
  }
  const result = spawnSync("bunx", ["playwright", "test", ...run.args], {
    stdio: "inherit",
    env: run.phase ? { ...process.env, E2E_PHASE: run.phase } : process.env,
  });
  if (result.error) throw result.error;
  // Playwright exits with 130 when it is interrupted: stop instead of starting the next run.
  if (result.signal !== null || result.status === 130) process.exit(result.status ?? 130);
  if (status === 0) status = result.status ?? 1;
}
process.exit(status);
