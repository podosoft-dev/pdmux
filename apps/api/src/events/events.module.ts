import { AppException } from "@podosoft/podokit-contracts";
import { Elysia, sse, t } from "elysia";
import {
  type AppPlugin,
  type PodokitModule,
  READINESS,
  type ServiceKey,
} from "../core/services";
import { EventsService } from "./events.service";
import { createEventsTransport } from "./events.transport";

export const EVENTS = Symbol("events") as ServiceKey<EventsService>;

const eventsPlugin: AppPlugin = ({ services }) => {
  const events = services.resolve(EVENTS);
  return new Elysia({ name: "podokit.events" })
    .get("/events/stream", async function* ({ request }) {
      for await (const data of events.stream(request.signal)) yield sse({ data });
    }, {
      detail: { tags: ["events"], summary: "Stream server-sent events" },
    })
    .post("/events", async ({ body, set }) => {
      try {
        await events.publishAsync({ type: "message", message: body.message });
      } catch {
        throw new AppException(
          "EVENTS_TRANSPORT_UNAVAILABLE",
          "Event transport is unavailable",
          503,
        );
      }
      set.status = 201;
      return { ok: true as const };
    }, {
      body: t.Object({ message: t.String() }),
      detail: { tags: ["events"], summary: "Publish an event" },
    });
};

export const eventsModule: PodokitModule = {
  name: "sse",
  configure: (_env, services): void => {
    const events = new EventsService(createEventsTransport(), services.resolve(READINESS));
    services.register(EVENTS, events, () => events.close());
    services.onStart(() => events.connect());
  },
  plugin: eventsPlugin,
};
