import type { JobInput } from "../runtime/jobs";

export async function processDemoJob(job: Pick<JobInput, "data">): Promise<{ upper: string }> {
  await Bun.sleep(500);
  return { upper: String(job.data.text ?? "").toUpperCase() };
}
