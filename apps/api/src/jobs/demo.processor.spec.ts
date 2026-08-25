import { describe, expect, it } from "bun:test";
import type { Job } from "bullmq";
import { processDemoJob } from "./demo.processor";

describe("processDemoJob", () => {
  it("returns upper-case text", async () => {
    const job = { data: { text: "hello" } } as Job<{ text: string }>;
    await expect(processDemoJob(job)).resolves.toEqual({ upper: "HELLO" });
  });
});
