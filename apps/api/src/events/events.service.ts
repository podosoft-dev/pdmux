import {
  Inject,
  Injectable,
  Logger,
  type MessageEvent,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Observable, Subject } from "rxjs";
import { ReadinessService } from "../health/readiness.service";
import type { EventsTransport } from "./events.transport";

export const EVENTS_TRANSPORT = Symbol("EVENTS_TRANSPORT");

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly subject = new Subject<MessageEvent>();
  private unregisterReadiness?: () => void;

  constructor(
    @Inject(EVENTS_TRANSPORT) private readonly transport: EventsTransport,
    private readonly readiness: ReadinessService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.transport.connect((data) => this.publishLocal(data));
    this.unregisterReadiness = this.readiness.register("events", () => this.transport.ready());
  }

  publish(data: unknown): void {
    void this.publishAsync(data).catch((error: unknown) => {
      this.logger.error(
        "Failed to publish event",
        error instanceof Error ? error.stack : undefined,
      );
    });
  }

  publishAsync(data: unknown): Promise<void> {
    return this.transport.publish(data);
  }

  publishLocal(data: unknown): void {
    this.subject.next({ data } as MessageEvent);
  }

  asObservable(): Observable<MessageEvent> {
    return this.subject.asObservable();
  }

  async onModuleDestroy(): Promise<void> {
    this.unregisterReadiness?.();
    this.subject.complete();
    await this.transport.close();
  }
}
