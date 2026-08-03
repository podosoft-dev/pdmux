import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { DEMO_QUEUE } from "./queue";

@Processor(DEMO_QUEUE)
export class DemoProcessor extends WorkerHost {
  async process(job: Job<{ text: string }>): Promise<{ upper: string }> {
    // Simulate work.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { upper: String(job.data.text ?? "").toUpperCase() };
  }
}
