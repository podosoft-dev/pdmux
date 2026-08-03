import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./jobs/worker.module";

// Runs BullMQ processors in their own process (no HTTP server).
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  await app.init();
  // Keep the process alive to consume jobs.
  process.on("SIGINT", () => void app.close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void app.close().then(() => process.exit(0)));
}

void bootstrap();
