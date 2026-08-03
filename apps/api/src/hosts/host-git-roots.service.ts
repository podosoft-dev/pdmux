import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AppException } from "../common/app-exception";
import { CreateHostGitRootDto, UpdateHostGitRootDto } from "./dto/host-git-root.dto";
import { MAX_GIT_ROOTS_PER_HOST } from "./git-roots";
import { HostGitRoot } from "./host-git-root.entity";
import { HostsService } from "./hosts.service";

/**
 * Notified after a root changes, because that row IS half of the agent's git
 * configuration — the same contract `HostServiceChangeListener` has, for the same
 * reason: one host, not a scope.
 */
export type HostGitRootChangeListener = (
  hostId: string,
  organizationId: string,
) => Promise<void> | void;


@Injectable()
export class HostGitRootsService {
  private readonly logger = new Logger(HostGitRootsService.name);
  private changeListener: HostGitRootChangeListener = () => {};

  constructor(
    @InjectRepository(HostGitRoot) private readonly roots: Repository<HostGitRoot>,
    private readonly hosts: HostsService,
  ) {}

  /** Called once by the agent config pusher at startup (avoids a circular provider). */
  setChangeListener(listener: HostGitRootChangeListener): void {
    this.changeListener = listener;
  }

  /** Scoped lookup first, so a root id from another organization is a 404. */
  async list(organizationId: string, hostId: string): Promise<HostGitRoot[]> {
    const host = await this.hosts.get(organizationId, hostId);
    return this.roots.find({ where: { hostId: host.id }, order: { sortOrder: "ASC", path: "ASC" } });
  }

  /** Roots for an agent's config — the gateway has a host id, not a session. */
  async listForHost(hostId: string): Promise<HostGitRoot[]> {
    return this.roots.find({ where: { hostId }, order: { sortOrder: "ASC", path: "ASC" } });
  }

  async create(organizationId: string, hostId: string, dto: CreateHostGitRootDto): Promise<HostGitRoot> {
    const host = await this.hosts.get(organizationId, hostId);
    await this.assertPathFree(host.id, dto.path, null);
    await this.assertRoom(host.id);
    const sortOrder = dto.sortOrder ?? (await this.nextSortOrder(host.id));
    const created = await this.roots.save(
      this.roots.create({
        hostId: host.id,
        path: dto.path,
        sortOrder,
        // A root is added in order to be scanned; off is something you choose later.
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
    dto: UpdateHostGitRootDto,
  ): Promise<HostGitRoot> {
    const root = await this.get(organizationId, hostId, id);
    if (dto.path !== undefined && dto.path !== root.path) {
      await this.assertPathFree(root.hostId, dto.path, root.id);
      root.path = dto.path;
    }
    if (dto.enabled !== undefined) root.enabled = dto.enabled;
    if (dto.sortOrder !== undefined) root.sortOrder = dto.sortOrder;
    const saved = await this.roots.save(root);
    await this.notifyChanged(saved.hostId, organizationId);
    return saved;
  }

  async remove(organizationId: string, hostId: string, id: string): Promise<{ id: string; path: string }> {
    const root = await this.get(organizationId, hostId, id);
    await this.roots.delete({ id: root.id });
    // ⚠ REMOVING THE LAST ROW HANDS THE HOST BACK TO THE FLEET LIST, which is a
    // different set of paths, not "nothing". The push is what makes that take
    // effect rather than leaving the agent on a configuration nobody can see.
    await this.notifyChanged(root.hostId, organizationId);
    return { id: root.id, path: root.path };
  }

  async get(organizationId: string, hostId: string, id: string): Promise<HostGitRoot> {
    const host = await this.hosts.get(organizationId, hostId);
    const root = await this.roots.findOne({ where: { id, hostId: host.id } });
    if (!root) throw new AppException("HOST_GIT_ROOT_NOT_FOUND", "Git root not found", 404);
    return root;
  }

  /** The row is already written, so a failed push is logged rather than failing the edit. */
  private async notifyChanged(hostId: string, organizationId: string): Promise<void> {
    try {
      await this.changeListener(hostId, organizationId);
    } catch (error) {
      this.logger.warn(`Config push after a git-root change failed host=${hostId}: ${String(error)}`);
    }
  }

  private async assertPathFree(hostId: string, path: string, exceptId: string | null): Promise<void> {
    const existing = await this.roots.findOne({ where: { hostId, path } });
    if (existing && existing.id !== exceptId) {
      throw new AppException("HOST_GIT_ROOT_PATH_TAKEN", "That path is already listed", 409);
    }
  }

  private async assertRoom(hostId: string): Promise<void> {
    const count = await this.roots.count({ where: { hostId } });
    if (count >= MAX_GIT_ROOTS_PER_HOST) {
      throw new AppException(
        "HOST_GIT_ROOT_LIMIT",
        `A host takes at most ${MAX_GIT_ROOTS_PER_HOST} git roots`,
        409,
      );
    }
  }

  private async nextSortOrder(hostId: string): Promise<number> {
    const last = await this.roots.findOne({ where: { hostId }, order: { sortOrder: "DESC" } });
    return last ? last.sortOrder + 1 : 0;
  }
}
