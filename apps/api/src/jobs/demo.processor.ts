import type { Job } from "bullmq";

export async function processDemoJob(job: Job<{ text: string }>): Promise<{ upper: string }> {
  await Bun.sleep(500);
  return { upper: String(job.data.text ?? "").toUpperCase() };
}
