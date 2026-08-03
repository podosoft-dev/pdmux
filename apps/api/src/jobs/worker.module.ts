import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { DemoProcessor } from "./demo.processor";
import { DEMO_QUEUE, redisConnection } from "./queue";
import { HostsWorkerModule } from "../hosts/hosts-worker.module";
import { MetricsWorkerModule } from "../metrics/metrics-worker.module";
// podokit:begin:worker-imports
// podokit:end:worker-imports

// Consumer side: runs BullMQ processors. Bootstrapped by main-worker.ts as a
// separate process so workers scale independently of the API.
@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnection() }),
    BullModule.registerQueue({ name: DEMO_QUEUE }),
    // pdmux: metric retention runs here so a large delete never shares a thread
    // with an API request that is relaying terminal bytes.
    MetricsWorkerModule,
    // pdmux: the stale-host sweep, for the same reason — deleting a host cascades
    // into its samples. ⚠ It relies on the connection `MetricsWorkerModule` opens
    // (TypeOrmCoreModule is @Global()), so it must stay listed after it.
    HostsWorkerModule,
    // podokit:begin:worker-queues
    // podokit:end:worker-queues
  ],
  providers: [
    DemoProcessor,
    // podokit:begin:worker-providers
    // podokit:end:worker-providers
  ],
})
export class WorkerModule {}
