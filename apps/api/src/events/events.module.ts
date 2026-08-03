import { Global, Module } from "@nestjs/common";
import { EventsController } from "./events.controller";
import { EVENTS_TRANSPORT, EventsService } from "./events.service";
import { createEventsTransport } from "./events.transport";

// Global so any module can inject EventsService to broadcast updates.
@Global()
@Module({
  controllers: [EventsController],
  providers: [
    {
      provide: EVENTS_TRANSPORT,
      useFactory: () => createEventsTransport(),
    },
    EventsService,
  ],
  exports: [EventsService],
})
export class EventsModule {}
