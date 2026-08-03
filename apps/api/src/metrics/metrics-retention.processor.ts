import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { MetricsRetentionService, type RetentionRun } from "./metrics-retention.service";
import { METRICS_QUEUE } from "./metrics.queue";

/** Runs in the worker process (main-worker.ts), so a long delete never blocks a
 *  request thread that is relaying terminal bytes. */
@Processor(METRICS_QUEUE)
export class MetricsRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(MetricsRetentionProcessor.name);

  constructor(private readonly retention: MetricsRetentionService) {
    super();
  }

  async process(): Promise<RetentionRun> {
    const result = await this.retention.runOnce();
    this.logger.log(
      `Metric retention run scopes=${result.scopes} hosts=${result.hosts} deleted=${result.deleted}`,
    );
    return result;
  }
}
