import { ProductLogger } from "../logging/product-logger";
import { Repository } from "typeorm";
import { AppException } from "../common/app-exception";
import {
  CreateHostServiceDto,
  UpdateHostServiceDto,
} from "./dto/host-service.dto";
import { HostService } from "./host-service.entity";
import { HostsService } from "./hosts.service";
import { orderAssignments } from "./host-view";

/**
 * Notified after a service row changes, because that row IS the agent's probe list.
 *
 * One host, not a scope: a service belongs to exactly one machine, so nobody else's
 * config moved. Registered from the agents side at startup, like the fleet-settings
 * listener next door.
 */
export type HostServiceChangeListener = (
  hostId: string,
  organizationId: string,
) => Promise<void> | void;

export class HostServicesService {
  private readonly logger = new ProductLogger(HostServicesService.name);
  private changeListener: HostServiceChangeListener = () => {};

  constructor(
    private readonly services: Repository<HostService>,
    private readonly hosts: HostsService,
  ) {}

  /** Called once by the agent config pusher at startup (avoids a circular provider). */
  setChangeListener(listener: HostServiceChangeListener): void {
    this.changeListener = listener;
  }

  /** Every method resolves the host through the scoped lookup first, so a service
   *  id from another organization is a 404 before it is ever queried. */
  async list(organizationId: string, hostId: string): Promise<HostService[]> {
    const host = await this.hosts.get(organizationId, hostId);
    return this.services.find({ where: { hostId: host.id }, order: { sortOrder: "ASC", label: "ASC" } });
  }

  /** Services for an agent's config — the gateway has a host id, not a session. */
  async listForHost(hostId: string): Promise<HostService[]> {
    return this.services.find({ where: { hostId }, order: { sortOrder: "ASC", label: "ASC" } });
  }

  async create(organizationId: string, hostId: string, dto: CreateHostServiceDto): Promise<HostService> {
    const host = await this.hosts.get(organizationId, hostId);
    await this.assertLabelFree(host.id, dto.label, null);
    const sortOrder = dto.sortOrder ?? (await this.nextSortOrder(host.id));
    const created = await this.services.save(
      this.services.create({
        hostId: host.id,
        label: dto.label,
        port: dto.port,
        probe: dto.probe ?? "tcp",
        path: dto.path ?? "/",
        urlTemplate: dto.urlTemplate ?? null,
        sortOrder,
        // A service is registered to be watched; off is something you choose later.
        enabled: dto.enabled ?? true,
      }),
    );
    await this.notifyChanged(host.id, organizationId);
    return created;
  }

  async update(
    organizationId: string,
    hostId: string,
    id: string,
    dto: UpdateHostServiceDto,
  ): Promise<HostService> {
    const service = await this.get(organizationId, hostId, id);
    if (dto.label !== undefined && dto.label !== service.label) {
      await this.assertLabelFree(service.hostId, dto.label, service.id);
      service.label = dto.label;
    }
    if (dto.port !== undefined) service.port = dto.port;
    if (dto.probe !== undefined) service.probe = dto.probe;
    if (dto.path !== undefined) service.path = dto.path;
    if (dto.urlTemplate !== undefined) service.urlTemplate = dto.urlTemplate ?? null;
    if (dto.sortOrder !== undefined) service.sortOrder = dto.sortOrder;
    if (dto.enabled !== undefined) service.enabled = dto.enabled;
    const saved = await this.services.save(service);
    await this.notifyChanged(saved.hostId, organizationId);
    return saved;
  }

  async remove(organizationId: string, hostId: string, id: string): Promise<{ id: string; label: string }> {
    const service = await this.get(organizationId, hostId, id);
    await this.services.delete({ id: service.id });
    // A deleted service is a port the agent must stop opening, so the push matters
    // here for the same reason it does on create.
    await this.notifyChanged(service.hostId, organizationId);
    return { id: service.id, label: service.label };
  }

  async reorder(organizationId: string, hostId: string, ids: string[]): Promise<HostService[]> {
    const host = await this.hosts.get(organizationId, hostId);
    const rows = await this.services.find({ where: { hostId: host.id }, select: { id: true } });
    const { assignments, missing } = orderAssignments(ids, new Set(rows.map((r) => r.id)));
    if (missing.length > 0) throw new AppException("HOST_SERVICE_NOT_FOUND", "Service not found", 404);
    for (const assignment of assignments) {
      await this.services.update({ id: assignment.id, hostId: host.id }, { sortOrder: assignment.sortOrder });
    }
    return this.list(organizationId, host.id);
  }

  async get(organizationId: string, hostId: string, id: string): Promise<HostService> {
    const host = await this.hosts.get(organizationId, hostId);
    const service = await this.services.findOne({ where: { id, hostId: host.id } });
    if (!service) throw new AppException("HOST_SERVICE_NOT_FOUND", "Service not found", 404);
    return service;
  }

  /** Same contract as the fleet-settings listener: the row is already written, so a
   *  push that fails is logged and swallowed rather than failing the edit. */
  private async notifyChanged(hostId: string, organizationId: string): Promise<void> {
    try {
      await this.changeListener(hostId, organizationId);
    } catch (error) {
      this.logger.warn(`Config push after a service change failed host=${hostId}: ${String(error)}`);
    }
  }

  private async nextSortOrder(hostId: string): Promise<number> {
    const last = await this.services.findOne({
      where: { hostId },
      order: { sortOrder: "DESC" },
      select: { id: true, sortOrder: true },
    });
    return last ? last.sortOrder + 1 : 0;
  }

  private async assertLabelFree(hostId: string, label: string, exceptId: string | null): Promise<void> {
    const existing = await this.services.findOne({ where: { hostId, label }, select: { id: true } });
    if (existing && existing.id !== exceptId) {
      throw new AppException("HOST_SERVICE_LABEL_TAKEN", `A service named "${label}" already exists on this host`, 409);
    }
  }
}
