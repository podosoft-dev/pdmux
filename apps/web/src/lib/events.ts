// One shared EventSource per tab for the sse module's /events/stream.
//
// Subscribe from $effect or onMount so the stream only opens in the browser:
//
//   $effect(() => subscribe("job-progress", (message) => {
//     if (message.resync) void reload();
//     else progress = message.data;
//   }));
//
// A resync message means events may have been missed (the server dropped a
// backlog, or the stream reconnected). Reload the state the topic describes.

const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type StreamMessage =
  | { resync: false; topic: string; id: string; data: unknown }
  | { resync: true; topic: string };

export type StreamHandler = (message: StreamMessage) => void;

export interface EventStreamClientOptions {
  url?: string;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  createSource?: (url: string) => EventSource;
}

interface Subscription {
  topic: string;
  handler: StreamHandler;
  /** True once the subscription has been connected; a later reconnect owes it a resync. */
  live: boolean;
}

function streamPayload(data: unknown): { topic: string; data: unknown } | undefined {
  if (typeof data !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { topic, data: payload } = parsed as Record<string, unknown>;
  return typeof topic === "string" ? { topic, data: payload } : undefined;
}

export class EventStreamClient {
  private readonly subscriptions = new Map<string, Set<Subscription>>();
  private source?: EventSource;
  private sourceTopics = new Set<string>();
  private open = false;
  private attempt = 0;
  private syncTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: EventStreamClientOptions = {}) {}

  subscribe(topic: string, handler: StreamHandler): () => void {
    if (!EVENT_NAME.test(topic)) throw new TypeError(`Invalid event topic: ${topic}`);
    if (!this.options.createSource && typeof EventSource === "undefined") return () => undefined;
    const subscription: Subscription = {
      topic,
      handler,
      live: this.open && this.sourceTopics.has(topic),
    };
    const subscriptions = this.subscriptions.get(topic) ?? new Set<Subscription>();
    subscriptions.add(subscription);
    this.subscriptions.set(topic, subscriptions);
    this.scheduleSync();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      subscriptions.delete(subscription);
      if (subscriptions.size === 0 && this.subscriptions.get(topic) === subscriptions) {
        this.subscriptions.delete(topic);
      }
      this.scheduleSync();
    };
  }

  // Deferred so components that unsubscribe and resubscribe in one tick, or several
  // components that subscribe together, cause at most one reconnect.
  private scheduleSync(): void {
    if (this.syncTimer !== undefined) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      this.sync();
    }, 0);
  }

  private sync(): void {
    const topics = [...this.subscriptions.keys()];
    if (topics.length === 0) {
      this.stop();
      return;
    }
    // Topics that lost their last subscriber stay on the connection until the next
    // reconnect; reconnecting only to drop them would cost every other topic a resync.
    const connecting = this.source !== undefined || this.retryTimer !== undefined;
    if (connecting && topics.every((topic) => this.sourceTopics.has(topic))) return;
    this.connect(topics);
  }

  private connect(topics: string[]): void {
    this.closeSource();
    this.clearRetry();
    this.sourceTopics = new Set(topics);
    const query = new URLSearchParams({ topics: [...topics].sort().join(",") });
    const createSource = this.options.createSource ?? ((url: string) => new EventSource(url));
    const source = createSource(`${this.options.url ?? "/api/events/stream"}?${query}`);
    this.source = source;
    source.addEventListener("open", () => {
      if (this.source === source) this.opened();
    });
    source.addEventListener("message", (event) => {
      if (this.source === source) this.dispatch(event);
    });
    source.addEventListener("resync", () => {
      if (this.source === source) this.resync(false);
    });
    source.addEventListener("error", () => {
      if (this.source === source) this.failed();
    });
  }

  private opened(): void {
    this.open = true;
    this.attempt = 0;
    this.resync(true);
  }

  private resync(reconnected: boolean): void {
    for (const subscriptions of [...this.subscriptions.values()]) {
      for (const subscription of [...subscriptions]) {
        if (!this.sourceTopics.has(subscription.topic)) continue;
        const owed = !reconnected || subscription.live;
        subscription.live = true;
        if (owed) this.notify(subscription, { resync: true, topic: subscription.topic });
      }
    }
  }

  private dispatch(event: MessageEvent): void {
    const payload = streamPayload(event.data);
    if (!payload) return;
    const subscriptions = this.subscriptions.get(payload.topic);
    if (!subscriptions) return;
    const message: StreamMessage = {
      resync: false,
      topic: payload.topic,
      id: event.lastEventId,
      data: payload.data,
    };
    for (const subscription of [...subscriptions]) this.notify(subscription, message);
  }

  // EventSource retries on its own at a fixed interval and gives up for good on an
  // HTTP error, so close it and retry with exponential backoff instead.
  private failed(): void {
    this.closeSource();
    const minimum = this.options.minBackoffMs ?? 1_000;
    const maximum = this.options.maxBackoffMs ?? 30_000;
    const ceiling = Math.min(maximum, minimum * 2 ** this.attempt);
    const delay = Math.round(ceiling / 2 + (this.options.random ?? Math.random)() * (ceiling / 2));
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const topics = [...this.subscriptions.keys()];
      if (topics.length > 0) this.connect(topics);
    }, delay);
  }

  private notify(subscription: Subscription, message: StreamMessage): void {
    try {
      subscription.handler(message);
    } catch (error) {
      console.error(error);
    }
  }

  private closeSource(): void {
    this.source?.close();
    this.source = undefined;
    this.open = false;
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private stop(): void {
    this.closeSource();
    this.clearRetry();
    this.attempt = 0;
    this.sourceTopics = new Set();
  }
}

export const eventStream = new EventStreamClient();

export function subscribe(topic: string, handler: StreamHandler): () => void {
  return eventStream.subscribe(topic, handler);
}
