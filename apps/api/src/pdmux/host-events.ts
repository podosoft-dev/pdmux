import type { EventBus, Unsubscribe } from "@podosoft/podokit-runtime";
import { ProductLogger } from "../logging/product-logger";

/**
 * Bus topic for host change notices. It is not an SSE topic: `/fleet/events`
 * subscribes to it and re-checks the session and scope before telling a browser
 * that its hosts changed, so these notices never reach a client as they are.
 */
export const HOST_EVENTS_TOPIC = "pdmux.hosts";

export interface HostEvent {
  type: `host.${string}`;
  hostId: string;
}

export type HostEventListener = (event: unknown) => void;

/** Fans host change notices out to every API replica through the events provider. */
export class HostEvents {
  private readonly logger = new ProductLogger(HostEvents.name);

  constructor(private readonly bus: EventBus) {}

  /** Best-effort: the state behind the notice is already committed. */
  publish(event: HostEvent): void {
    void this.bus.publish(HOST_EVENTS_TOPIC, event).catch((error: unknown) => {
      this.logger.warn(`Publish host event failed type=${event.type}: ${String(error)}`);
    });
  }

  subscribe(listener: HostEventListener): Promise<Unsubscribe> {
    return this.bus.subscribe(HOST_EVENTS_TOPIC, listener);
  }
}
