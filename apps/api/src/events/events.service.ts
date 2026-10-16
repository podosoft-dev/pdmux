import { AppException } from "@podosoft/podokit-contracts";
import type { EventBus, Unsubscribe } from "@podosoft/podokit-runtime";
import { ReadinessService } from "../health/readiness.service";
import {
  audienceMatcher,
  readEnvelope,
  validEnvelope,
  type EventEnvelope,
  type EventSubscriber,
} from "./event-envelope";
import {
  EventStream,
  timerScheduler,
  type EventStreamOptions,
  type Scheduler,
} from "./event-stream";
import { TopicAuthorizers } from "./event-topics";

/** Every replica subscribes to this one transport topic and filters locally. */
const TRANSPORT_TOPIC = "sse";

export interface EventsServiceOptions {
  /** Events buffered for one slow client before it is told to resync. */
  queueLimit?: number;
  heartbeatMs?: number;
  /** Reconnect delay the stream advertises to EventSource clients. */
  retryMs?: number;
  /** Streams end after this long so clients reconnect with a fresh identity. */
  maxConnectionMs?: number;
  /** Open streams one user may hold on this replica. */
  maxStreamsPerUser?: number;
  scheduler?: Scheduler;
  now?: () => number;
}

export class EventsService {
  readonly topics = new TopicAuthorizers();
  readonly retryMs: number;
  private readonly streamOptions: EventStreamOptions;
  private readonly maxStreamsPerUser: number;
  private readonly streams = new Set<EventStream>();
  private readonly byUser = new Map<string, Set<EventStream>>();
  private readonly byTopic = new Map<string, Set<EventStream>>();
  private readonly everyTopic = new Set<EventStream>();
  private unregisterReadiness?: () => void;
  private unsubscribe?: Unsubscribe;
  private stopResync?: () => void;

  constructor(
    private readonly transport: EventBus,
    private readonly readiness: ReadinessService,
    options: EventsServiceOptions = {},
  ) {
    this.retryMs = options.retryMs ?? 3_000;
    this.maxStreamsPerUser = options.maxStreamsPerUser ?? 8;
    this.streamOptions = {
      queueLimit: options.queueLimit ?? 256,
      heartbeatMs: options.heartbeatMs ?? 5_000,
      maxConnectionMs: options.maxConnectionMs ?? 30 * 60_000,
      scheduler: options.scheduler ?? timerScheduler,
      now: options.now ?? Date.now,
    };
  }

  get streamCount(): number {
    return this.streams.size;
  }

  async connect(): Promise<void> {
    this.unsubscribe = await this.transport.subscribe(TRANSPORT_TOPIC, (value) => {
      const envelope = readEnvelope(value);
      if (typeof envelope === "string") {
        process.stderr.write(`Discard invalid event: ${envelope}\n`);
        return;
      }
      this.deliver(envelope);
    });
    // Events published while the transport was down never arrive, so open
    // streams are told to reload once it is back.
    this.stopResync = this.transport.onInterruption?.(() => {
      for (const stream of this.streams) stream.resync();
    });
    this.unregisterReadiness = this.readiness.register("events", () => this.transport.ready());
  }

  /** Best-effort delivery for state that is already committed. Throws on an invalid event. */
  publish(event: EventEnvelope): void {
    const envelope = validEnvelope(event);
    void this.transport.publish(TRANSPORT_TOPIC, envelope).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Publish event failed: ${message}\n`);
    });
  }

  /** Resolves once the transport accepted the event; rejects when it did not. */
  async publishAsync(event: EventEnvelope): Promise<void> {
    await this.transport.publish(TRANSPORT_TOPIC, validEnvelope(event));
  }

  /** Delivers to this replica only, for events another channel already fanned out. */
  publishLocal(event: EventEnvelope): void {
    this.deliver(validEnvelope(event));
  }

  /**
   * Opens a stream for `subscriber`. Without `topics` the stream receives every
   * topic that has no authorizer; guarded topics must be requested by name. A
   * user beyond the per-user limit is refused rather than closing an older
   * stream, which would make that client reconnect and refuse the next one.
   */
  async open(
    subscriber: EventSubscriber,
    topics: readonly string[] | undefined,
    signal: AbortSignal,
  ): Promise<EventStream> {
    for (const topic of topics ?? []) {
      if (!(await this.topics.allows(subscriber, topic))) {
        throw new AppException(
          "EVENTS_TOPIC_FORBIDDEN",
          `You cannot subscribe to ${topic}`,
          403,
        );
      }
    }
    // No await between this check and attach(), so concurrent opens cannot pass it together.
    if ((this.byUser.get(subscriber.userId)?.size ?? 0) >= this.maxStreamsPerUser) {
      throw new AppException("EVENTS_STREAM_LIMIT", "Too many open event streams", 429);
    }
    const stream = new EventStream(
      subscriber,
      topics ? new Set(topics) : undefined,
      this.streamOptions,
      (closed) => this.detach(closed),
    );
    this.attach(stream);
    stream.start(signal);
    return stream;
  }

  async close(): Promise<void> {
    this.unregisterReadiness?.();
    this.stopResync?.();
    await this.unsubscribe?.();
    for (const stream of [...this.streams]) stream.close();
  }

  private deliver(event: EventEnvelope): void {
    const matches = audienceMatcher(event.audience);
    let payload: string | undefined;
    const offer = (stream: EventStream): void => {
      if (!matches(stream.subscriber)) return;
      payload ??= JSON.stringify({ topic: event.topic, data: event.data });
      stream.offer(payload, event.id);
    };
    for (const stream of this.byTopic.get(event.topic) ?? []) offer(stream);
    if (!this.topics.guarded(event.topic)) {
      for (const stream of this.everyTopic) offer(stream);
    }
  }

  private attach(stream: EventStream): void {
    this.streams.add(stream);
    const held = this.byUser.get(stream.subscriber.userId) ?? new Set<EventStream>();
    held.add(stream);
    this.byUser.set(stream.subscriber.userId, held);
    if (!stream.topics) {
      this.everyTopic.add(stream);
      return;
    }
    for (const topic of stream.topics) {
      const streams = this.byTopic.get(topic) ?? new Set<EventStream>();
      streams.add(stream);
      this.byTopic.set(topic, streams);
    }
  }

  private detach(stream: EventStream): void {
    this.streams.delete(stream);
    const held = this.byUser.get(stream.subscriber.userId);
    held?.delete(stream);
    if (held?.size === 0) this.byUser.delete(stream.subscriber.userId);
    if (!stream.topics) {
      this.everyTopic.delete(stream);
      return;
    }
    for (const topic of stream.topics) {
      const streams = this.byTopic.get(topic);
      if (!streams) continue;
      streams.delete(stream);
      if (streams.size === 0) this.byTopic.delete(topic);
    }
  }
}
