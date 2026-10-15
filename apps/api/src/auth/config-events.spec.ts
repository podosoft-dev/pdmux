import { describe, expect, test } from "bun:test";
import { MemoryEventBus, type EventBus } from "@podosoft/podokit-runtime";
import { CONFIG_CHANGED_TOPIC, createConfigEvents } from "./config-events";

describe("settings change events", () => {
  test("invalidates other processes but not the publisher", async () => {
    const bus = new MemoryEventBus();
    const replicaA = createConfigEvents();
    const replicaB = createConfigEvents();
    let changesA = 0;
    let changesB = 0;
    await replicaA.listen(bus, () => { changesA += 1; });
    await replicaB.listen(bus, () => { changesB += 1; });

    await replicaA.publish();
    await Bun.sleep(0);
    expect(changesA).toBe(0);
    expect(changesB).toBe(1);
    await bus.close();
  });

  test("does nothing without an events provider and tolerates a failing one", async () => {
    await expect(createConfigEvents().publish()).resolves.toBeUndefined();

    const failing: EventBus = {
      ready: async () => undefined,
      publish: async () => {
        throw new Error("redis unavailable");
      },
      subscribe: async () => () => undefined,
      close: () => undefined,
    };
    const events = createConfigEvents();
    await events.listen(failing, () => undefined);
    await expect(events.publish()).resolves.toBeUndefined();
    expect(CONFIG_CHANGED_TOPIC).toBe("config.changed");
  });
});
