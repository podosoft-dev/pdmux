import {
  Body,
  Controller,
  Post,
  ServiceUnavailableException,
  Sse,
  type MessageEvent,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { interval, map, merge, type Observable } from "rxjs";
import { EventsService } from "./events.service";
import { PublishEventDto } from "./dto/publish-event.dto";

@ApiTags("events")
@Controller("events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse("stream")
  stream(): Observable<MessageEvent> {
    const heartbeat = interval(5000).pipe(
      map((n): MessageEvent => ({ data: { type: "heartbeat", n } })),
    );
    return merge(this.events.asObservable(), heartbeat);
  }

  @Post()
  async publish(@Body() dto: PublishEventDto): Promise<{ ok: true }> {
    try {
      await this.events.publishAsync({ type: "message", message: dto.message });
    } catch {
      throw new ServiceUnavailableException({
        code: "EVENTS_TRANSPORT_UNAVAILABLE",
        message: "Event transport is unavailable",
      });
    }
    return { ok: true };
  }
}
