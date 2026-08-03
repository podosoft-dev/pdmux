import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { JobsController } from "./jobs.controller";
import { DEMO_QUEUE, redisConnection } from "./queue";

// Producer side: registers the queue and exposes enqueue/status endpoints.
// The processor runs in a separate worker process (see main-worker.ts).
@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnection() }),
    BullModule.registerQueue({ name: DEMO_QUEUE }),
  ],
  controllers: [JobsController],
})
export class JobsModule {}
