import type { EventBus } from "@podosoft/podokit-runtime";

export const CONFIG_CHANGED_TOPIC = "config.changed";

export interface ConfigEvents {
  /** Run `onChange` when another process reports a settings write. */
  listen(events: EventBus, onChange: () => void): Promise<void>;
  /** Report a local settings write. Without a listening bus this does nothing. */
  publish(): Promise<void>;
}

function originOf(event: unknown): unknown {
  return event !== null && typeof event === "object" ? (event as { origin?: unknown }).origin : undefined;
}

/** Cross-replica invalidation over the optional events provider. Delivery is
 *  best effort: a lost message only delays convergence to the settings TTL. */
export function createConfigEvents(): ConfigEvents {
  const origin = crypto.randomUUID();
  let bus: EventBus | undefined;
  return {
    async listen(events, onChange): Promise<void> {
      await events.subscribe(CONFIG_CHANGED_TOPIC, (event) => {
        if (originOf(event) !== origin) onChange();
      });
      bus = events;
    },
    async publish(): Promise<void> {
      if (!bus) return;
      try {
        await bus.publish(CONFIG_CHANGED_TOPIC, { origin });
      } catch (err) {
        console.warn("[auth-config] could not publish a settings change; other replicas follow within the TTL:", err instanceof Error ? err.message : err);
      }
    },
  };
}

export const configEvents = createConfigEvents();

export function publishConfigChanged(): Promise<void> {
  return configEvents.publish();
}
