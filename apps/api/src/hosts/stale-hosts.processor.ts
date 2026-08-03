import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { StaleHostsService, type StaleHostSweep } from "./stale-hosts.service";
import { STALE_HOSTS_QUEUE } from "./stale-hosts.queue";

/**
 * Runs in the worker process (main-worker.ts), so a scope's worth of cascading
 * deletes never shares a thread with an API request that is relaying terminal
 * bytes — the same reason the metric prune lives there.
 *
 * The run is logged even when it removed nothing: "the sweep is armed and found
 * nothing" and "the sweep never ran" are the two states an operator needs to tell
 * apart when a host they expected to be gone is still listed.
 */
@Processor(STALE_HOSTS_QUEUE)
export class StaleHostsProcessor extends WorkerHost {
  private readonly logger = new Logger(StaleHostsProcessor.name);

  constructor(private readonly stale: StaleHostsService) {
    super();
  }

  async process(): Promise<StaleHostSweep> {
    const result = await this.stale.runOnce();
    this.logger.log(
      `Stale host sweep scopes=${result.scopes} armed=${result.armed} removed=${result.removed}`,
    );
    return result;
  }
}
