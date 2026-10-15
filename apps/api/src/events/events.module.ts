import { AppException } from "@podosoft/podokit-contracts";
import { EVENTS } from "@podosoft/podokit-runtime";
import { Elysia, t } from "elysia";
import {
  READINESS,
  REQUEST_IDENTITY,
  type AppPlugin,
  type ElysiaPlugin,
  type PodokitModule,
  type RequestIdentity,
  type ServiceKey,
} from "../core/services";
import {
  EVENT_NAME_PATTERN,
  InvalidEventError,
  type EventEnvelope,
  type EventSubscriber,
} from "./event-envelope";
import { eventStreamResponse } from "./event-stream";
import { parseTopics } from "./event-topics";
import { EventsService } from "./events.service";

export const SSE_EVENTS = Symbol("sse-events") as ServiceKey<EventsService>;

/** Resolves who opens a stream. Register one in app.extensions.ts to replace the default. */
export interface EventIdentity {
  subscriber(request: Request): Promise<EventSubscriber | undefined>;
}

export const EVENT_IDENTITY = Symbol("event-identity") as ServiceKey<EventIdentity>;

/** The default identity: the request user with their roles and active organization. */
export function requestEventIdentity(identity: RequestIdentity): EventIdentity {
  return {
    subscriber: async (request) => {
      const userId = await identity.userId(request);
      if (!userId) return undefined;
      const [roles, organizationId] = await Promise.all([
        identity.roles(request),
        identity.activeOrganizationId(request),
      ]);
      return organizationId === undefined ? { userId, roles } : { userId, roles, organizationId };
    },
  };
}

const nameSchema = t.String({ pattern: EVENT_NAME_PATTERN });
const idListSchema = t.Array(t.String({ minLength: 1, maxLength: 256 }), { maxItems: 1_000 });
const audienceSchema = t.Object(
  {
    userIds: t.Optional(idListSchema),
    roles: t.Optional(idListSchema),
    organizationId: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

async function requireAdmin(identity: RequestIdentity, request: Request): Promise<void> {
  if (!(await identity.userId(request))) {
    throw new AppException("AUTH_REQUIRED", "Authentication is required", 401);
  }
  if (!(await identity.isAdmin(request))) {
    throw new AppException("ADMIN_REQUIRED", "Administrator access is required", 403);
  }
}

export function eventsRoutes(
  events: EventsService,
  identity: RequestIdentity,
  eventIdentity: EventIdentity = requestEventIdentity(identity),
): ElysiaPlugin {
  return new Elysia({ name: "podokit.events" })
    .get("/events/stream", async ({ request, query }) => {
      const subscriber = await eventIdentity.subscriber(request);
      if (!subscriber) throw new AppException("AUTH_REQUIRED", "Authentication is required", 401);
      const stream = await events.open(subscriber, parseTopics(query.topics), request.signal);
      return eventStreamResponse(stream, events.retryMs);
    }, {
      query: t.Object({ topics: t.Optional(t.String({ maxLength: 4_096 })) }),
      detail: {
        tags: ["events"],
        summary: "Stream server-sent events",
        description:
          "Signed-in users only. `topics` is a comma-separated list; without it the stream " +
          "carries every topic that has no authorizer. Each data event is a default " +
          "`message` whose data is `{ topic, data }`. A `resync` event means events were " +
          "dropped and the client should reload its state.",
      },
    })
    .post("/events", async ({ request, body, set }) => {
      await requireAdmin(identity, request);
      const event: EventEnvelope = {
        topic: body.topic ?? "message",
        data: { message: body.message },
        ...(body.audience ? { audience: body.audience } : {}),
      };
      try {
        await events.publishAsync(event);
      } catch (error) {
        if (error instanceof InvalidEventError) {
          throw new AppException("EVENTS_INVALID", error.message, 400);
        }
        throw new AppException(
          "EVENTS_TRANSPORT_UNAVAILABLE",
          "Event transport is unavailable",
          503,
        );
      }
      set.status = 201;
      return { ok: true as const };
    }, {
      body: t.Object({
        message: t.String({ maxLength: 4_096 }),
        topic: t.Optional(nameSchema),
        audience: t.Optional(audienceSchema),
      }),
      detail: {
        tags: ["events"],
        summary: "Publish an event",
        description: "Administrators only. Publishes `{ message }` to `topic` (default `message`).",
      },
    });
}

const eventsPlugin: AppPlugin = ({ services }) =>
  eventsRoutes(
    services.resolve(SSE_EVENTS),
    services.resolve(REQUEST_IDENTITY),
    services.tryResolve(EVENT_IDENTITY),
  );

export const eventsModule: PodokitModule = {
  name: "sse",
  configure: (_env, services): void => {
    const events = new EventsService(services.resolve(EVENTS), services.resolve(READINESS));
    services.register(SSE_EVENTS, events, () => events.close());
    services.onStart(() => events.connect());
  },
  plugin: eventsPlugin,
};
