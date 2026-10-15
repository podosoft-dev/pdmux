import { AppException } from "@podosoft/podokit-contracts";
import { EVENT_NAME_PATTERN, isEventName, type EventSubscriber } from "./event-envelope";

export const MAX_STREAM_TOPICS = 32;

export type TopicAuthorizer = (
  subscriber: EventSubscriber,
  topic: string,
) => boolean | Promise<boolean>;

interface PrefixAuthorizer {
  prefix: string;
  authorize: TopicAuthorizer;
}

/**
 * Restricts who may subscribe to a topic. A topic without an authorizer is open to
 * every signed-in user. A pattern ending in `*` guards every topic with that prefix,
 * and every authorizer that matches a topic must allow the subscriber.
 */
export class TopicAuthorizers {
  private readonly exact = new Map<string, TopicAuthorizer[]>();
  private readonly prefixes: PrefixAuthorizer[] = [];

  register(pattern: string, authorize: TopicAuthorizer): void {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (!isEventName(prefix)) throw new TypeError(`Topic prefix must match ${EVENT_NAME_PATTERN}`);
      this.prefixes.push({ prefix, authorize });
      return;
    }
    if (!isEventName(pattern)) throw new TypeError(`Topic must match ${EVENT_NAME_PATTERN}`);
    this.exact.set(pattern, [...(this.exact.get(pattern) ?? []), authorize]);
  }

  guarded(topic: string): boolean {
    return this.exact.has(topic) || this.prefixes.some(({ prefix }) => topic.startsWith(prefix));
  }

  async allows(subscriber: EventSubscriber, topic: string): Promise<boolean> {
    const authorizers = [
      ...(this.exact.get(topic) ?? []),
      ...this.prefixes.filter(({ prefix }) => topic.startsWith(prefix)).map(({ authorize }) => authorize),
    ];
    for (const authorize of authorizers) {
      if (!(await authorize(subscriber, topic))) return false;
    }
    return true;
  }
}

/** Parses `?topics=a,b`. Undefined means every topic that has no authorizer. */
export function parseTopics(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const topics = [...new Set(value.split(",").map((topic) => topic.trim()).filter(Boolean))];
  if (topics.length === 0 || topics.length > MAX_STREAM_TOPICS || !topics.every(isEventName)) {
    throw new AppException(
      "EVENTS_TOPICS_INVALID",
      `topics must list 1 to ${MAX_STREAM_TOPICS} comma-separated names matching ${EVENT_NAME_PATTERN}`,
      400,
    );
  }
  return topics;
}
