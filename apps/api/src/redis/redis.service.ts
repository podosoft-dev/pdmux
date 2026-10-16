import { RedisClient } from "bun";
import {
  RedisCommandTimeoutError,
  redisCommandTimeoutMs,
  redisConnectionUrl,
  withReplyTimeout,
} from "../config/redis.connection";
import type { SupervisedConnection } from "../core/services";

export type RedisMessageHandler = (message: string) => void;

/**
 * Commands fail at once while the client is disconnected instead of queueing,
 * and the service's supervisor reconnects instead of Bun, which gives up after
 * a fixed number of attempts and never restores subscriptions.
 */
export function createRedisClient(): RedisClient {
  return new RedisClient(redisConnectionUrl(), {
    connectionTimeout: 5_000,
    autoReconnect: false,
    enableOfflineQueue: false,
  });
}

export class RedisService implements SupervisedConnection {
  readonly client: RedisClient;
  private readonly channels = new Map<string, Set<RedisMessageHandler>>();
  // Channels the current subscriber connection holds on the server.
  private readonly active = new Set<string>();
  private subscriber?: RedisClient;
  private opening?: Promise<RedisClient>;
  private lostListener?: (reason: unknown) => void;
  private closed = false;

  constructor(
    private readonly createClient: () => RedisClient = createRedisClient,
    private readonly commandTimeoutMs = redisCommandTimeoutMs(),
  ) {
    this.client = createClient();
    this.client.onclose = (error) => this.report(error);
  }

  onLost(listener: (reason: unknown) => void): void {
    this.lostListener = listener;
  }

  /** Opens the command connection and restores every subscription. */
  async connect(): Promise<void> {
    if (!this.client.connected) await this.client.connect();
    await this.ping();
    if (this.channels.size > 0) await this.listen();
  }

  /**
   * Runs `send` on the command connection. When Redis does not answer within
   * `REDIS_COMMAND_TIMEOUT_MS`, it fails with `RedisCommandTimeoutError` and the
   * connection is closed and reopened by the supervisor. Use it for commands
   * this service does not wrap, instead of calling `client` directly.
   */
  async command<T>(send: (client: RedisClient) => Promise<T>): Promise<T> {
    return withReplyTimeout(send(this.client), this.commandTimeoutMs, () => this.client.close());
  }

  /** Whether a failed command means Redis could not be reached, rather than that it refused the command. */
  isUnavailable(error: unknown): boolean {
    return error instanceof RedisCommandTimeoutError || !this.client.connected;
  }

  async ping(): Promise<void> {
    await this.command((client) => client.ping());
  }

  get(key: string): Promise<string | null> {
    return this.command((client) => client.get(key));
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.command((client) => client.set(key, value));
    if (ttlSeconds !== undefined) await this.command((client) => client.expire(key, ttlSeconds));
  }

  del(key: string): Promise<number> {
    return this.command((client) => client.del(key));
  }

  publish(channel: string, message: string): Promise<number> {
    return this.command((client) => client.publish(channel, message));
  }

  /**
   * Calls `handler` for every message on `channel`. The subscription does not
   * need Redis to be reachable now: it starts once Redis is, and comes back
   * after every reconnect. Messages published while disconnected are lost.
   */
  async subscribe(channel: string, handler: RedisMessageHandler): Promise<() => Promise<void>> {
    const handlers = this.channels.get(channel) ?? new Set<RedisMessageHandler>();
    handlers.add(handler);
    this.channels.set(channel, handlers);
    if (this.client.connected) {
      // A failure reaches the supervisor through onclose or below, and the
      // next reconnect subscribes again.
      await this.listen().catch((error: unknown) => this.report(error));
    }
    return async () => {
      handlers.delete(handler);
      if (handlers.size > 0 || this.channels.get(channel) !== handlers) return;
      this.channels.delete(channel);
      if (!this.active.delete(channel)) return;
      await this.subscriber?.unsubscribe(channel).catch(() => undefined);
    };
  }

  close(): void {
    this.closed = true;
    this.subscriber?.close();
    this.subscriber = undefined;
    this.active.clear();
    this.client.close();
  }

  private readonly dispatch = (message: string, channel: string): void => {
    for (const handler of this.channels.get(channel) ?? []) handler(message);
  };

  private async listen(): Promise<void> {
    const subscriber = this.subscriber ?? await (this.opening ??= this.openSubscriber());
    const missing = [...this.channels.keys()].filter((channel) => !this.active.has(channel));
    if (missing.length === 0) return;
    await withReplyTimeout(
      subscriber.subscribe(missing, this.dispatch),
      this.commandTimeoutMs,
      () => subscriber.close(),
    );
    if (this.subscriber !== subscriber) return;
    for (const channel of missing) this.active.add(channel);
  }

  /** A fresh connection, because Bun keeps the listeners of a dropped one without the server subscription. */
  private async openSubscriber(): Promise<RedisClient> {
    try {
      const subscriber = this.createClient();
      subscriber.onclose = (error) => {
        if (this.subscriber !== subscriber) return;
        this.subscriber = undefined;
        this.active.clear();
        this.report(error);
      };
      try {
        await subscriber.connect();
      } catch (error) {
        subscriber.close();
        throw error;
      }
      this.subscriber = subscriber;
      return subscriber;
    } finally {
      this.opening = undefined;
    }
  }

  private report(reason: unknown): void {
    if (!this.closed) this.lostListener?.(reason);
  }
}
