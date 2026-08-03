import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Not, Repository } from "typeorm";
import { AppException } from "../common/app-exception";
import { HostsService } from "../hosts/hosts.service";
import { UserHostPref } from "./user-host-pref.entity";
import { UserLayout } from "./user-layout.entity";

export interface LayoutView {
  name: string;
  isDefault: boolean;
  payload: Record<string, unknown>;
  updatedAt: string;
}

export interface PrefsView {
  layouts: LayoutView[];
  hostPrefs: Record<string, Record<string, unknown>>;
}

const MAX_LAYOUTS_PER_USER = 50;
const LAYOUT_NAME = /^[\w -]{1,64}$/;

function toLayoutView(row: UserLayout): LayoutView {
  return {
    name: row.name,
    isDefault: row.isDefault,
    payload: row.payload,
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class PrefsService {
  constructor(
    @InjectRepository(UserLayout) private readonly layouts: Repository<UserLayout>,
    @InjectRepository(UserHostPref) private readonly hostPrefs: Repository<UserHostPref>,
    private readonly hosts: HostsService,
  ) {}

  /** One call restores a session: every layout plus every per-host card setting. */
  async read(userId: string): Promise<PrefsView> {
    const [layouts, prefs] = await Promise.all([
      this.layouts.find({ where: { userId }, order: { name: "ASC" } }),
      this.hostPrefs.find({ where: { userId } }),
    ]);
    const hostPrefs: Record<string, Record<string, unknown>> = {};
    for (const pref of prefs) hostPrefs[pref.hostId] = pref.widgets;
    return { layouts: layouts.map(toLayoutView), hostPrefs };
  }

  async putLayout(
    userId: string,
    name: string,
    payload: Record<string, unknown>,
    isDefault: boolean,
  ): Promise<LayoutView> {
    if (!LAYOUT_NAME.test(name)) {
      throw new AppException("LAYOUT_NAME_INVALID", "Layout name must be 1-64 word characters", 400);
    }
    const existing = await this.layouts.findOne({ where: { userId, name } });
    if (!existing) {
      const count = await this.layouts.count({ where: { userId } });
      if (count >= MAX_LAYOUTS_PER_USER) {
        throw new AppException("LAYOUT_LIMIT_REACHED", "Too many saved layouts", 409);
      }
    }
    const row = existing ?? this.layouts.create({ userId, name });
    row.payload = payload;
    row.isDefault = isDefault;
    const saved = await this.layouts.save(row);
    // Demote the others only after the write succeeds, so a failure cannot leave a
    // user with no default at all.
    if (isDefault) {
      await this.layouts.update({ userId, id: Not(saved.id) }, { isDefault: false });
    }
    return toLayoutView(saved);
  }

  async deleteLayout(userId: string, name: string): Promise<{ name: string }> {
    const existing = await this.layouts.findOne({ where: { userId, name } });
    if (!existing) throw new AppException("LAYOUT_NOT_FOUND", "Layout not found", 404);
    await this.layouts.delete({ id: existing.id });
    return { name };
  }

  async putHostPref(
    userId: string,
    organizationId: string,
    hostId: string,
    widgets: Record<string, unknown>,
  ): Promise<{ hostId: string; widgets: Record<string, unknown> }> {
    // Scoped host lookup first: a preference row is also an existence oracle.
    const host = await this.hosts.get(organizationId, hostId);
    const existing = await this.hostPrefs.findOne({ where: { userId, hostId: host.id } });
    const row = existing ?? this.hostPrefs.create({ userId, hostId: host.id });
    row.widgets = widgets;
    const saved = await this.hostPrefs.save(row);
    return { hostId: saved.hostId, widgets: saved.widgets };
  }
}
