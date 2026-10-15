import { describe, expect, it } from "bun:test";
import { externalJobId, parseExternalJobId } from "./bullmq-job.queue";

describe("BullMQ job identifiers", () => {
  it("round-trips queue names without exposing an ambiguous id", () => {
    const id = externalJobId("email/delivery", "42");
    expect(parseExternalJobId(id)).toEqual({ name: "email/delivery", id: "42" });
    expect(parseExternalJobId("invalid")).toBeNull();
  });
});
