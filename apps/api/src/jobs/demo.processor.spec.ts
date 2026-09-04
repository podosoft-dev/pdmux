import { describe, expect, it } from "bun:test";
import { processDemoJob } from "./demo.processor";

describe("processDemoJob", () => {
  it("returns upper-case text", async () => {
    const job = { data: { text: "hello" } };
    await expect(processDemoJob(job)).resolves.toEqual({ upper: "HELLO" });
  });
});
