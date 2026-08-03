import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Public } from "@thallesp/nestjs-better-auth";
import { ReadinessService, type ReadinessStatus } from "./readiness.service";

interface ReadinessResponse {
  status: "ready";
  db: "up";
  checks: Record<string, ReadinessStatus>;
}

// Health checks stay public under the global auth guard.
@Public()
@Controller("health")
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly readinessService: ReadinessService,
  ) {}

  @Get()
  liveness(): { status: string; uptime: number; timestamp: string } {
    return { status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() };
  }

  @Get("ready")
  async readiness(): Promise<ReadinessResponse> {
    let db: ReadinessStatus = "up";
    try {
      await this.dataSource.query("SELECT 1");
    } catch {
      db = "down";
    }
    const checks = await this.readinessService.run();
    if (db === "down" || Object.values(checks).includes("down")) {
      throw new ServiceUnavailableException({ status: "degraded", db, checks });
    }
    return { status: "ready", db: "up", checks };
  }
}
