import { createHash } from "node:crypto";
import { canonical, chooseChange, mapHostIds, omitHostReferences, DESKTOP_PROTOCOL_VERSION, syncBatchSchema, type SyncRecord, type SyncResult } from "@pdmux/desktop-protocol";
import type { QueryDeepPartialEntity, Repository } from "typeorm";
import { AppException } from "../common/app-exception";
import type { AuthSession } from "../auth/auth.service";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import type { PdmuxServices } from "../pdmux/pdmux.services";
import { DesktopRecord } from "./desktop-record.entity";
import { KeyedMutex } from "./keyed-mutex";
import { appearanceSchema, hostSchema, layoutSchema, widgetsSchema } from "./record-schema";

export function recordHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function select<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> { return Object.fromEntries(keys.map(key => [key, value[key]])) as Pick<T, K>; }
const hostKeys = ["label", "address", "description", "tags", "sortOrder", "enabled"] as const;
const serviceKeys = ["id", "label", "port", "probe", "path", "urlTemplate", "sortOrder", "enabled"] as const;
const rootKeys = ["id", "path", "sortOrder", "enabled"] as const;

/** Hosts, with their services and Git roots, belong to the scope and are shared by its members. */
export function hostsLockKey(session: AuthSession): string { return `hosts:${resolveScopeId(session)}`; }
/** Layouts, card widgets and appearance belong to the user in every scope. */
export function prefsLockKey(session: AuthSession): string { return `prefs:${session.user.id}`; }

export class DesktopService {
  /**
   * Keeps a write from landing between a sync's comparison and its apply, where it would be
   * overwritten unseen. A sync reads the scope's hosts and the user's preferences and takes both
   * keys; any other write takes the key of what it changes, so other users and scopes never wait.
   * The lock is per process. That holds because one API process serves a database (the agent
   * registry and the desktop bridge peers are in memory too); more would need a database lock.
   */
  readonly lock = new KeyedMutex();
  connectionKey = "";
  origin = "server";
  constructor(readonly pdmux: PdmuxServices, private readonly records: Repository<DesktopRecord>) {}

  syncKeys(session: AuthSession): string[] { return [hostsLockKey(session), prefsLockKey(session)]; }
  /** The key for a `/prefs…` or `/hosts…` write (see `metadataWrite`). */
  writeKeys(session: AuthSession, path: string): string[] { return [/^\/prefs(?:\/|$)/.test(path) ? prefsLockKey(session) : hostsLockKey(session)]; }

  private id(session: AuthSession, record: SyncRecord, connectionKey: string): string {
    return recordHash([resolveScopeId(session), record.kind === "host" ? "" : session.user.id, record.key, connectionKey]);
  }
  async bindings(session: AuthSession): Promise<DesktopRecord[]> {
    const rows = await this.records.find({ where: { scopeId: resolveScopeId(session) } });
    return rows.filter(row => (row.kind === "host" || row.userId === session.user.id) && (!row.connectionKey || row.connectionKey === this.connectionKey));
  }
  async binding(session: AuthSession, hostId: string): Promise<DesktopRecord | undefined> {
    return (await this.bindings(session)).find(row => row.kind === "host" && row.hostId === hostId);
  }
  async snapshot(session: AuthSession): Promise<SyncRecord[]> {
    const scope = resolveScopeId(session);
    const bindings = await this.bindings(session);
    const hosts = await this.pdmux.hosts.list(scope);
    const live = new Set(hosts.map(host => host.id));
    const records: SyncRecord[] = [];
    const ids = new Map<string, string>();
    for (const host of hosts) {
      const binding = bindings.find(row => row.hostId === host.id && row.kind === "host");
      // A cached host from a different account must not be re-exported as local.
      if (!binding && await this.records.exist({ where: { hostId: host.id } })) continue;
      const key = binding?.key ?? `host:${this.origin}:${host.id}`;
      ids.set(host.id, key);
      if (binding && binding.origin !== this.origin) {
        records.push({ key, kind: "host", origin: binding.origin, value: binding.value }); continue;
      }
      const [services, roots] = await Promise.all([this.pdmux.hostServices.list(scope, host.id), this.pdmux.hostGitRoots.list(scope, host.id)]);
      const native: SyncRecord = { key, kind: "host", origin: this.origin, value: {
        ...select(host, hostKeys), services: services.map(row => select(row, serviceKeys)), roots: roots.map(row => select(row, rootKeys)),
      } };
      records.push(native);
      await this.remember(session, native, host.id);
    }
    for (const binding of bindings) {
      if (binding.kind === "host" && (!binding.hostId || !live.has(binding.hostId))) records.push({ key: binding.key, kind: "host", origin: binding.origin, value: null });
    }
    const blocked = new Set(hosts.map(host => host.id).filter(id => !ids.has(id)));
    const prefs = await this.pdmux.prefs.read(session.user.id);
    for (const layout of prefs.layouts) records.push({ key: `layout:${layout.name}`, kind: "layout", origin: "personal", value: { name: layout.name, isDefault: layout.isDefault, payload: mapHostIds(omitHostReferences(layout.payload, blocked), ids) } });
    for (const [id, widgets] of Object.entries(prefs.hostPrefs)) {
      const key = ids.get(id);
      if (key) records.push({ key: `widgets:${key}`, kind: "widgets", origin: "personal", value: { hostKey: key, widgets } });
    }
    for (const row of bindings) {
      if (row.kind === "appearance") records.push({ key: row.key, kind: row.kind, origin: row.origin, value: row.value });
      else if (row.kind !== "host" && !records.some(record => record.key === row.key)) records.push({ key: row.key, kind: row.kind, origin: row.origin, value: null });
    }
    return records;
  }

  async sync(session: AuthSession, body: unknown): Promise<SyncResult> {
    const batch = syncBatchSchema.parse(body);
    return this.lock.run(this.syncKeys(session), async () => {
      const current = new Map((await this.snapshot(session)).map(record => [record.key, record]));
      const conflicts: SyncResult["conflicts"] = [];
      // Hosts establish the ID mapping before layouts and per-host preferences.
      const changes = [...batch.changes].sort((a, b) => Number(b.kind === "host") - Number(a.kind === "host"));
      for (const change of changes) {
        if (change.kind === "host") assertCanManageFleet(session);
        const prior = current.get(change.key);
        if (prior && (prior.kind !== change.kind || prior.origin !== change.origin)) throw new AppException("DESKTOP_RECORD_INVALID", "Record ownership cannot change", 400);
        if (!prior && change.kind === "host" && (change.origin !== batch.deviceId || !change.key.startsWith(`host:${batch.deviceId}:`))) throw new AppException("DESKTOP_RECORD_INVALID", "Cannot claim this host", 403);
        const remote: SyncRecord = prior ?? { key: change.key, kind: change.kind, origin: change.origin, value: null };
        const decision = change.resolution && change.resolutionBase !== recordHash(remote.value) ? "conflict" : chooseChange(change.base, recordHash(change.value), recordHash(remote.value), current.has(change.key), change.resolution);
        if (decision === "conflict") { conflicts.push({ key: change.key, local: change, server: remote, serverHash: recordHash(remote.value) }); continue; }
        if (decision === "local") {
          const record: SyncRecord = { key: change.key, kind: change.kind, origin: change.origin, value: change.value };
          await this.apply(session, record);
          current.set(record.key, record);
        }
      }
      const snapshot = await this.snapshot(session);
      for (const record of snapshot) await this.remember(session, record);
      return { version: DESKTOP_PROTOCOL_VERSION, records: snapshot.map(record => ({ ...record, hash: recordHash(record.value) })), conflicts, userId: session.user.id, scopeId: resolveScopeId(session), hostIds: Object.fromEntries((await this.bindings(session)).filter(row => row.hostId).map(row => [row.key, row.hostId!])) };
    });
  }

  private async remember(session: AuthSession, record: SyncRecord, hostId?: string | null): Promise<DesktopRecord> {
    const connectionKey = record.kind === "host" && record.origin !== this.origin ? this.connectionKey : "";
    const id = this.id(session, record, connectionKey);
    const existing = await this.records.findOneBy({ id });
    if (existing && recordHash(existing.value) === recordHash(record.value) && (hostId === undefined || hostId === existing.hostId)) return existing;
    return this.records.save(this.records.create({ ...existing, id, scopeId: resolveScopeId(session), userId: session.user.id,
      key: record.key, kind: record.kind, origin: record.origin, value: record.value, connectionKey,
      hostId: hostId === undefined ? existing?.hostId ?? (record.kind === "host" && record.origin === this.origin ? record.key.slice(record.key.lastIndexOf(":") + 1) : null) : hostId,
      cachedView: existing?.cachedView ?? null,
    }));
  }

  async apply(session: AuthSession, record: SyncRecord): Promise<void> {
    const scope = resolveScopeId(session);
    if (record.kind !== "host" && record.origin !== "personal") throw new AppException("DESKTOP_RECORD_INVALID", "Invalid personal record", 400);
    if (record.kind === "appearance" && record.key !== "appearance") throw new AppException("DESKTOP_RECORD_INVALID", "Invalid appearance key", 400);
    const rows = await this.bindings(session);
    let binding = rows.find(row => row.key === record.key && (row.kind === "host" || row.userId === session.user.id));
    if (record.kind === "host") {
      if (record.origin === this.origin && !binding) {
        const id = record.key.slice(record.key.lastIndexOf(":") + 1);
        await this.pdmux.hosts.get(scope, id);
        binding = await this.remember(session, record, id);
      }
      if (!record.value) {
        if (binding?.hostId) {
          // Native hosts use their usual removal path; a mirror has no credentials.
          await this.pdmux.hosts.remove(scope, binding.hostId).catch((error: unknown) => {
            if (!(error instanceof AppException && error.statusCode === 404)) throw error;
          });
        }
        await this.remember(session, record, null); return;
      }
      const value = hostSchema.parse(record.value);
      if (record.origin !== this.origin) {
        if (!binding?.hostId) {
          const host = await this.pdmux.hosts.create(scope, { label: `desktop:${recordHash(record.key).slice(0, 48)}`, enabled: value.enabled });
          binding = await this.remember(session, record, host.id);
        } else await this.pdmux.hosts.update(scope, binding.hostId, { enabled: value.enabled, sortOrder: value.sortOrder });
        await this.remember(session, record, binding.hostId); return;
      }
      if (!binding?.hostId) throw new AppException("HOST_NOT_FOUND", "Host not found", 404);
      await this.pdmux.hosts.update(scope, binding.hostId, select(value, hostKeys));
      const oldServices = await this.pdmux.hostServices.list(scope, binding.hostId);
      for (const old of oldServices) if (!value.services.some(item => item.id === old.id)) await this.pdmux.hostServices.remove(scope, binding.hostId, old.id);
      for (const service of value.services) {
        const { id, ...input } = service;
        if (oldServices.some(item => item.id === id)) await this.pdmux.hostServices.update(scope, binding.hostId, id, input);
        else await this.pdmux.hostServices.create(scope, binding.hostId, input, id);
      }
      const oldRoots = await this.pdmux.hostGitRoots.list(scope, binding.hostId);
      for (const old of oldRoots) if (!value.roots.some(item => item.id === old.id)) await this.pdmux.hostGitRoots.remove(scope, binding.hostId, old.id);
      for (const root of value.roots) {
        const { id, ...input } = root;
        if (oldRoots.some(item => item.id === id)) await this.pdmux.hostGitRoots.update(scope, binding.hostId, id, input);
        else await this.pdmux.hostGitRoots.create(scope, binding.hostId, input, id);
      }
    } else if (record.kind === "layout") {
      const name = record.key.slice("layout:".length);
      if (record.value) {
        const value = layoutSchema.parse(record.value);
        if (name !== value.name) throw new AppException("DESKTOP_RECORD_INVALID", "Layout key does not match", 400);
        const ids = new Map(rows.filter(row => row.hostId).map(row => [row.key, row.hostId!]));
        await this.pdmux.prefs.putLayout(session.user.id, name, mapHostIds(value.payload, ids) as Record<string, unknown>, value.isDefault);
      } else {
        await this.pdmux.prefs.deleteLayout(session.user.id, name).catch((error: unknown) => { if (!(error instanceof AppException && error.statusCode === 404)) throw error; });
      }
    } else if (record.kind === "widgets" && record.value) {
      const value = widgetsSchema.parse(record.value);
      const hostId = rows.find(row => row.key === value.hostKey)?.hostId;
      if (record.key !== `widgets:${value.hostKey}` || !hostId) throw new AppException("DESKTOP_RECORD_INVALID", "Unknown preference host", 400);
      await this.pdmux.prefs.putHostPref(session.user.id, scope, hostId, value.widgets);
    } else if (record.kind === "widgets" && !record.value) {
      const hostId = rows.find(row => row.key === record.key.slice("widgets:".length))?.hostId;
      if (hostId) await this.pdmux.prefs.deleteHostPref(session.user.id, scope, hostId);
    } else if (record.kind === "appearance" && record.value) appearanceSchema.parse(record.value);
    await this.remember(session, record);
  }

  async hasForeignBinding(hostId: string): Promise<boolean> { return this.records.exist({ where: { hostId } }); }

  /** Writes only the cached view: the binding was read before a lock-free relay, and a sync may have changed the rest since. */
  async cacheView(binding: DesktopRecord, view: Record<string, unknown>): Promise<void> { if (recordHash(binding.cachedView) !== recordHash(view)) await this.records.update({ id: binding.id }, { cachedView: view } as QueryDeepPartialEntity<DesktopRecord>); }
}
