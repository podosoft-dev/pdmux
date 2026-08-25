import { ProductLogger } from "../logging/product-logger";
import { MetricsRetentionService, type RetentionRun } from "./metrics-retention.service";

/** Runs in the worker process (main-worker.ts), so a long delete never blocks a
 *  request thread that is relaying terminal bytes. */
export class MetricsRetentionProcessor {
  private readonly logger = new ProductLogger(MetricsRetentionProcessor.name);

  constructor(private readonly retention: MetricsRetentionService) {
  }

  async process(): Promise<RetentionRun> {
    const result = await this.retention.runOnce();
    this.logger.log(
      `Metric retention run scopes=${result.scopes} hosts=${result.hosts} deleted=${result.deleted}`,
    );
    return result;
  }
}
