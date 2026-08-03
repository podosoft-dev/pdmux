import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { STALE_HOSTS_CRON, STALE_HOSTS_JOB, STALE_HOSTS_QUEUE } from "./stale-hosts.queue";

/**
 * Registers the repeatable stale-host sweep at boot.
 *
 * Failure is logged, not thrown — Redis being down must not stop the API from
 * serving hosts and terminals. The consequence of a missed registration is that
 * hosts past their window survive another day, which the next successful boot
 * fixes. ⚠ That direction is deliberate and it is the safe one: the failure mode
 * of this job not running is data staying, never data going.
 */
@Injectable()
export class StaleHostsScheduler implements OnModuleInit {
  private readonly logger = new Logger(StaleHostsScheduler.name);

  constructor(@InjectQueue(STALE_HOSTS_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        STALE_HOSTS_JOB,
        {},
        {
          repeat: { pattern: STALE_HOSTS_CRON },
          jobId: STALE_HOSTS_JOB,
          removeOnComplete: true,
          removeOnFail: 20,
        },
      );
    } catch (error) {
      this.logger.warn(`Schedule stale host sweep failed: ${String(error)}`);
    }
  }
}
