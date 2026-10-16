import { RedisClient } from "bun";
import type { EventBus, EventHandler, Unsubscribe } from "@podosoft/podokit-runtime";
import {
  redisCommandTimeoutMs,
  redisConnectionUrl,
  withReplyTimeout,
} from "../config/redis.connection";
import type { SupervisedConnection } from "../core/services";

/**
 * Publishing fails at once while disconnected instead of queueing, and the
 * supervisor reconnects instead of Bun, which gives up after a fixed number of
 * attempts and never restores subscriptions.
 */
function redisClientFactory(env: NodeJS.ProcessEnv): () => RedisClient {
  const url = redisConnectionUrl(env);
  return () => new RedisClient(url, {
    connectionTimeout: 5_000,
    autoReconnect: false,
    enableOfflineQueue: false,
  });
}

/**
 * Every replica subscribes to one Redis channel and dispatches to its local
 * handlers by topic. Handlers are local, so they survive reconnects; the
 * channel subscription is opened again on each reconnect.
 */
export class RedisEventBus implements EventBus, SupervisedConnection {
  private readonly publisher: RedisClient;
  private readonly channel: string;
  private readonly maxEventBytes: number;
  private readonly commandTimeoutMs: number;
  private readonly createClient: () => RedisClient;
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly interruptionListeners = new Set<() => void>();
  // Set while a connection holds the channel subscription.
  private subscriber?: RedisClient;
  // Whether events may have been missed since the channel was last subscribed.
  private missedEvents = false;
  private lostListener?: (reason: unknown) => void;
  private closed = false;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    createClient: () => RedisClient = redisClientFactory(env),
  ) {
    this.createClient = createClient;
    this.publisher = createClient();
    this.publisher.onclose = (error) => this.report(error);
    this.channel = env.EVENTS_REDIS_CHANNEL?.trim() || "podokit:events";
    this.maxEventBytes = Number(env.SSE_MAX_EVENT_BYTES ?? 65_536);
    if (!Number.isSafeInteger(this.maxEventBytes) || this.maxEventBytes < 1) {
      throw new Error("SSE_MAX_EVENT_BYTES must be a positive integer");
    }
    this.commandTimeoutMs = redisCommandTimeoutMs(env);
  }

  onLost(listener: (reason: unknown) => void): void {
    this.lostListener = listener;
  }

  /** Opens whichever connection is closed and subscribes the channel again. */
  async connect(): Promise<void> {
    try {
      if (!this.publisher.connected) await this.publisher.connect();
      this.subscriber ??= await this.openSubscriber();
    } catch (error) {
      if (!this.subscriber) this.missedEvents = true;
      throw error;
    }
    if (!this.missedEvents) return;
    this.missedEvents = false;
    for (const listener of [...this.interruptionListeners]) listener();
  }

  /** Rejects until the channel is subscribed and while the publisher cannot reach Redis. */
  async ready(): Promise<void> {
    if (!this.subscriber) throw new Error("Event transport is not subscribed");
    await this.send(() => this.publisher.ping());
  }

  async publish(topic: string, event: unknown): Promise<void> {
    const message = JSON.stringify({ topic, event });
    if (message === undefined) throw new Error("Event must be JSON serializable");
    if (Buffer.byteLength(message, "utf8") > this.maxEventBytes) {
      throw new Error(`Event exceeds maxEventBytes (${this.maxEventBytes})`);
    }
    await this.send(() => this.publisher.publish(this.channel, message));
  }

  subscribe(topic: string, handler: EventHandler): Promise<Unsubscribe> {
    const handlers = this.handlers.get(topic) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.handlers.set(topic, handlers);
    return Promise.resolve(() => {
      handlers.delete(handler);
      if (handlers.size === 0 && this.handlers.get(topic) === handlers) this.handlers.delete(topic);
    });
  }

  onInterruption(listener: () => void): () => void {
    this.interruptionListeners.add(listener);
    return () => {
      this.interruptionListeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    this.handlers.clear();
    this.interruptionListeners.clear();
    this.subscriber?.close();
    this.subscriber = undefined;
    this.publisher.close();
  }

  /** Fails a publisher command Redis does not answer in time and closes the connection for the supervisor to reopen. */
  private async send<T>(command: () => Promise<T>): Promise<T> {
    return withReplyTimeout(command(), this.commandTimeoutMs, () => this.publisher.close());
  }

  private readonly receive = (message: string): void => {
    if (Buffer.byteLength(message, "utf8") > this.maxEventBytes) return;
    try {
      const envelope = JSON.parse(message) as unknown;
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return;
      const record = envelope as Record<string, unknown>;
      if (typeof record.topic !== "string") return;
      for (const handler of this.handlers.get(record.topic) ?? []) {
        void Promise.resolve(handler(record.event)).catch(() => undefined);
      }
    } catch {
      process.stderr.write("Discard malformed event transport message\n");
    }
  };

  /** A fresh connection, because Bun keeps the listeners of a dropped one without the server subscription. */
  private async openSubscriber(): Promise<RedisClient> {
    const subscriber = this.createClient();
    subscriber.onclose = (error) => {
      if (this.subscriber !== subscriber) return;
      this.subscriber = undefined;
      this.missedEvents = true;
      this.report(error);
    };
    try {
      await subscriber.connect();
      await withReplyTimeout(
        subscriber.subscribe(this.channel, this.receive),
        this.commandTimeoutMs,
        () => subscriber.close(),
      );
    } catch (error) {
      subscriber.close();
      throw error;
    }
    return subscriber;
  }

  private report(reason: unknown): void {
    if (!this.closed) this.lostListener?.(reason);
  }
}
