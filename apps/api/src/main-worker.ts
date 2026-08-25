import "dotenv/config";
import { startWorkers } from "./jobs/worker.module";

const runtime = awaitRuntime();

async function awaitRuntime(): Promise<Awaited<ReturnType<typeof startWorkers>>> {
  const started = await startWorkers();
  for (const worker of started.workers) worker.on("failed", (job, error) => {
    process.stderr.write(`Process job failed: ${job?.id ?? "unknown"} ${error.message}\n`);
  });
  return started;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void runtime.then((started) => started.close()).finally(() => process.exit(0));
  });
}
