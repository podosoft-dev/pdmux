import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { resolveScopeId } from "../fleet/session-scope";
import { HostsService } from "../hosts/hosts.service";
import type { MetricSeries } from "./metric-series";
import { MetricsService } from "./metrics.service";

export interface MetricsResponse extends MetricSeries {
  hostId: string;
  latest: Awaited<ReturnType<MetricsService["latest"]>>;
}

/** Widest window the API will build. Beyond this the answer belongs in Grafana,
 *  not in a card — and an unbounded window is a trivial way to read the table. */
const MAX_WINDOW_SEC = 7 * 24 * 60 * 60;

@ApiTags("hosts")
@Controller("hosts/:id/metrics")
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly hosts: HostsService,
    private readonly settings: FleetSettingsService,
  ) {}

  @Get()
  async series(
    @Session() session: UserSession,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("window", new DefaultValuePipe(3600), ParseIntPipe) windowSec: number,
  ): Promise<MetricsResponse> {
    const organizationId = resolveScopeId(session);
    // Scoped read first: an unknown host must 404 before it can be measured.
    const host = await this.hosts.get(organizationId, id);
    const { metricStepSec } = await this.settings.resolve(organizationId);
    const window = Math.min(MAX_WINDOW_SEC, Math.max(metricStepSec, windowSec));
    const series = await this.metrics.series(host.id, { windowSec: window, stepSec: metricStepSec });
    return { hostId: host.id, ...series, latest: await this.metrics.latest(host.id) };
  }
}
