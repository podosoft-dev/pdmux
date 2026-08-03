import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { METRICS_PRUNE_CRON, METRICS_PRUNE_JOB, METRICS_QUEUE } from "./metrics.queue";

/**
 * Registers the repeatable prune job at boot.
 *
 * Failure is logged, not thrown: Redis being down must not stop the API from
 * serving hosts and terminals. The consequence of a missed registration is old
 * samples living longer, which the next successful boot fixes.
 */
@Injectable()
export class MetricsRetentionScheduler implements OnModuleInit {
  private readonly logger = new Logger(MetricsRetentionScheduler.name);

  constructor(@InjectQueue(METRICS_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        METRICS_PRUNE_JOB,
        {},
        {
          repeat: { pattern: METRICS_PRUNE_CRON },
          jobId: METRICS_PRUNE_JOB,
          removeOnComplete: true,
          removeOnFail: 20,
        },
      );
    } catch (error) {
      this.logger.warn(`Schedule metric retention job failed: ${String(error)}`);
    }
  }
}
