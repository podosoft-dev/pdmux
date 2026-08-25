import { describe, expect, it } from "bun:test";
import { ReadinessService } from "../health/readiness.service";
import { EventsService } from "./events.service";
import { MemoryEventsTransport } from "./events.transport";

describe("EventsService", () => {
  it("publishes through the transport and delivers locally", async () => {
    const readiness = new ReadinessService();
    const service = new EventsService(new MemoryEventsTransport(), readiness);
    const received: unknown[] = [];
    service.subscribe((data) => received.push(data));
    await service.connect();
    await service.publishAsync({ type: "changed" });
    expect(received).toEqual([{ type: "changed" }]);
    await expect(readiness.run()).resolves.toEqual({ events: "up" });
    await service.close();
  });

  it("rejects events larger than the configured limit", async () => {
    const service = new EventsService(
      new MemoryEventsTransport({ SSE_MAX_EVENT_BYTES: "8" }),
      new ReadinessService(),
    );
    await service.connect();
    await expect(service.publishAsync({ message: "too large" })).rejects.toThrow(
      "Event data exceeds SSE_MAX_EVENT_BYTES",
    );
    await service.close();
  });
});
