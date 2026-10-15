/** Every listed field must match. Within a list, any entry matches. */
export interface EventAudience {
  userIds?: string[];
  roles?: string[];
  organizationId?: string;
}

export interface EventEnvelope<T = unknown> {
  topic: string;
  /** Omit to deliver to every stream subscribed to the topic. */
  audience?: EventAudience;
  data: T;
  /** Sent as the SSE `id:`. Defaults to a per-connection sequence number. */
  id?: string;
}

/** The identity a stream was opened with, resolved once at connect. */
export interface EventSubscriber {
  userId: string;
  roles: readonly string[];
  organizationId?: string;
}

/** Topics and event ids share one charset so they can never break SSE framing. */
export const EVENT_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const EVENT_NAME = new RegExp(EVENT_NAME_PATTERN);

export class InvalidEventError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventError";
  }
}

export function isEventName(value: unknown): value is string {
  return typeof value === "string" && EVENT_NAME.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return undefined;
    items.push(item);
  }
  return items;
}

function readAudience(value: unknown): EventAudience | string {
  const source = record(value);
  if (!source) return "audience must be an object";
  const audience: EventAudience = {};
  if (source.userIds !== undefined) {
    const userIds = stringList(source.userIds);
    if (!userIds) return "audience.userIds must be a list of non-empty strings";
    audience.userIds = userIds;
  }
  if (source.roles !== undefined) {
    const roles = stringList(source.roles);
    if (!roles) return "audience.roles must be a list of non-empty strings";
    audience.roles = roles;
  }
  if (source.organizationId !== undefined) {
    if (typeof source.organizationId !== "string" || source.organizationId.length === 0) {
      return "audience.organizationId must be a non-empty string";
    }
    audience.organizationId = source.organizationId;
  }
  // An empty audience is almost always a recipient list that failed to resolve;
  // treating it as a broadcast would leak the event.
  if (
    audience.userIds === undefined &&
    audience.roles === undefined &&
    audience.organizationId === undefined
  ) {
    return "audience must set userIds, roles, or organizationId";
  }
  return audience;
}

/** Normalizes an envelope, or returns why it is invalid. */
export function readEnvelope(value: unknown): EventEnvelope | string {
  const source = record(value);
  if (!source) return "event must be an object";
  if (!isEventName(source.topic)) return `topic must match ${EVENT_NAME_PATTERN}`;
  if (source.id !== undefined && !isEventName(source.id)) {
    return `id must match ${EVENT_NAME_PATTERN}`;
  }
  const envelope: EventEnvelope = { topic: source.topic, data: source.data };
  if (source.id !== undefined) envelope.id = source.id;
  if (source.audience !== undefined) {
    const audience = readAudience(source.audience);
    if (typeof audience === "string") return audience;
    envelope.audience = audience;
  }
  return envelope;
}

export function validEnvelope(value: EventEnvelope): EventEnvelope {
  const envelope = readEnvelope(value);
  if (typeof envelope === "string") throw new InvalidEventError(`Invalid event: ${envelope}`);
  return envelope;
}

export type AudienceMatcher = (subscriber: EventSubscriber) => boolean;

export function audienceMatcher(audience: EventAudience | undefined): AudienceMatcher {
  if (!audience) return () => true;
  const userIds = audience.userIds ? new Set(audience.userIds) : undefined;
  const roles = audience.roles ? new Set(audience.roles) : undefined;
  const organizationId = audience.organizationId;
  if (!userIds && !roles && organizationId === undefined) return () => false;
  return (subscriber) =>
    (!userIds || userIds.has(subscriber.userId)) &&
    (!roles || subscriber.roles.some((role) => roles.has(role))) &&
    (organizationId === undefined || subscriber.organizationId === organizationId);
}
