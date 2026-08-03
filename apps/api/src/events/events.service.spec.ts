import { describe, expect, it } from "@jest/globals";
import { firstValueFrom, take } from "rxjs";
import { ReadinessService } from "../health/readiness.service";
import { EventsService } from "./events.service";
import type { EventHandler, EventsTransport } from "./events.transport";

class TestTransport implements EventsTransport {
  handler?: EventHandler;
  published: unknown[] = [];
  available = true;

  connect(handler: EventHandler): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }

  publish(data: unknown): Promise<void> {
    if (!this.available) return Promise.reject(new Error("unavailable"));
    this.published.push(data);
    this.handler?.(data);
    return Promise.resolve();
  }

  ready(): Promise<void> {
    return this.available ? Promise.resolve() : Promise.reject(new Error("unavailable"));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("EventsService", () => {
  it("publishes through the transport and exposes local delivery", async () => {
    const transport = new TestTransport();
    const readiness = new ReadinessService();
    const service = new EventsService(transport, readiness);
    await service.onModuleInit();

    const next = firstValueFrom(service.asObservable().pipe(take(1)));
    await service.publishAsync({ type: "changed" });
    await expect(next).resolves.toEqual({ data: { type: "changed" } });
    expect(transport.published).toEqual([{ type: "changed" }]);

    await expect(readiness.run()).resolves.toEqual({ events: "up" });
    await service.onModuleDestroy();
    await expect(readiness.run()).resolves.toEqual({});
  });

  it("reports a failed transport through publishAsync and readiness", async () => {
    const transport = new TestTransport();
    const readiness = new ReadinessService();
    const service = new EventsService(transport, readiness);
    await service.onModuleInit();
    transport.available = false;

    await expect(service.publishAsync({ type: "changed" })).rejects.toThrow("unavailable");
    await expect(readiness.run()).resolves.toEqual({ events: "down" });
    await service.onModuleDestroy();
  });
});
