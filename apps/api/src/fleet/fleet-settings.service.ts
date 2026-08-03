import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { FleetSetting } from "./fleet-setting.entity";
import {
  encodeSetting,
  FLEET_SETTING_KEYS,
  resolveFleetSettings,
  type FleetSettings,
} from "./fleet-settings";

/**
 * Notified after a write, so the agents already connected in that scope can be
 * retuned now instead of on their next reconnect.
 *
 * Set once at startup by the agents side — the same late binding
 * `HostsService.setConnectedProbe` uses, and for the same reason: the pusher
 * depends on this service, so importing it here would be a circular provider.
 */
export type FleetSettingsChangeListener = (organizationId: string) => Promise<void> | void;

@Injectable()
export class FleetSettingsService {
  private readonly logger = new Logger(FleetSettingsService.name);
  private changeListener: FleetSettingsChangeListener = () => {};

  constructor(
    @InjectRepository(FleetSetting) private readonly repo: Repository<FleetSetting>,
  ) {}

  /** Called once by the agent config pusher at startup (avoids a circular provider). */
  setChangeListener(listener: FleetSettingsChangeListener): void {
    this.changeListener = listener;
  }

  async resolve(organizationId: string): Promise<FleetSettings> {
    const rows = await this.repo.find({ where: { organizationId } });
    return resolveFleetSettings(rows);
  }

  /** Upsert only the keys present in `update`; unknown keys are dropped. */
  async update(organizationId: string, update: Partial<FleetSettings>): Promise<FleetSettings> {
    for (const key of FLEET_SETTING_KEYS) {
      const next = update[key];
      if (next === undefined) continue;
      await this.repo.upsert(
        { organizationId, key, value: encodeSetting(key, next) },
        ["organizationId", "key"],
      );
    }
    const settings = await this.resolve(organizationId);
    await this.notifyChanged(organizationId);
    return settings;
  }

  /**
   * ⚠ THE SAVE IS THE THING THAT SUCCEEDED. The rows are already written when this
   * runs, so a socket that closed mid-push must not turn a completed settings edit
   * into a 5xx the operator reads as "it did not save". Every failure is logged and
   * swallowed here; an agent that missed the frame still gets the new config in its
   * `welcome`.
   */
  private async notifyChanged(organizationId: string): Promise<void> {
    try {
      await this.changeListener(organizationId);
    } catch (error) {
      this.logger.warn(`Config push after a settings change failed scope=${organizationId}: ${String(error)}`);
    }
  }
}
