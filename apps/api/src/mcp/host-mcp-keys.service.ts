import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, Repository } from "typeorm";

import { AppException } from "../common/app-exception";
import { HostsService } from "../hosts/hosts.service";
import {
  expiryFrom,
  hashMcpKey,
  looksLikeMcpKey,
  mintMcpKey,
  tokenHashEquals,
  type McpKeyExpiryDays,
  type McpKeyScope,
} from "./host-mcp-key.crypto";
import { HostMcpKey } from "./host-mcp-key.entity";

/** What a key looks like to the UI — no secret material. */
export interface McpKeyView {
  id: string;
  hostId: string;
  label: string;
  keyPrefix: string;
  scopes: McpKeyScope[];
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Creation additionally returns the plaintext, exactly once. */
export interface MintedMcpKey extends McpKeyView {
  key: string;
}

/**
 * How coarse `lastUsedAt` is allowed to be.
 *
 * The endpoint is stateless, so "once per authentication" is once per TOOL CALL. The
 * column answers "was this credential used, and roughly when" — a question a minute's
 * resolution answers exactly as well as a millisecond's, for a fraction of the writes.
 */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * What a presented key resolves to. The host id is the scope; everything the MCP
 * surface does is reached through it.
 */
export interface McpIdentity {
  keyId: string;
  hostId: string;
  organizationId: string;
  scopes: McpKeyScope[];
}

function view(row: HostMcpKey): McpKeyView {
  return {
    id: row.id,
    hostId: row.hostId,
    label: row.label,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class HostMcpKeysService {
  private readonly logger = new Logger(HostMcpKeysService.name);

  constructor(
    @InjectRepository(HostMcpKey) private readonly keys: Repository<HostMcpKey>,
    private readonly hosts: HostsService,
  ) {}

  async list(organizationId: string, hostId: string): Promise<McpKeyView[]> {
    // Through the host, so a key for a host in another scope is not merely
    // filtered out of the list — it is never reached.
    await this.hosts.get(organizationId, hostId);
    const rows = await this.keys.find({ where: { hostId }, order: { createdAt: "DESC" } });
    return rows.map(view);
  }

  async mint(
    organizationId: string,
    hostId: string,
    input: { label: string; expiresInDays: McpKeyExpiryDays; scopes: McpKeyScope[] },
    createdByUserId: string | null,
  ): Promise<MintedMcpKey> {
    await this.hosts.get(organizationId, hostId);
    const minted = mintMcpKey();
    const row = await this.keys.save(
      this.keys.create({
        hostId,
        label: input.label.trim(),
        keyHash: minted.keyHash,
        keyPrefix: minted.keyPrefix,
        scopes: input.scopes,
        expiresAt: expiryFrom(new Date(), input.expiresInDays),
        lastUsedAt: null,
        revokedAt: null,
        createdByUserId,
      }),
    );
    // The only render of the plaintext. Nothing derived from it is stored, so a
    // later read cannot reproduce even the tail.
    return { ...view(row), key: minted.key };
  }

  async revoke(organizationId: string, hostId: string, id: string): Promise<McpKeyView> {
    const host = await this.hosts.get(organizationId, hostId);
    const row = await this.keys.findOne({ where: { id, hostId: host.id } });
    if (!row) throw new AppException("MCP_KEY_NOT_FOUND", "MCP key not found", 404);
    // Idempotent on the timestamp: revoking twice must not move the evidence of
    // when access actually ended.
    if (!row.revokedAt) {
      row.revokedAt = new Date();
      await this.keys.update({ id: row.id }, { revokedAt: row.revokedAt });
    }
    return view(row);
  }

  /**
   * Plaintext -> the host it speaks for.
   *
   * Returns null for anything that is not a live key, WITHOUT distinguishing
   * unknown from revoked from expired to the caller. The endpoint answers 401 for
   * all three: telling them apart tells an attacker which guesses were once real.
   */
  async authenticate(plaintext: string): Promise<McpIdentity | null> {
    if (!looksLikeMcpKey(plaintext)) return null;
    const keyHash = hashMcpKey(plaintext);
    const row = await this.keys.findOne({ where: { keyHash, revokedAt: IsNull() } });
    if (!row || !tokenHashEquals(row.keyHash, keyHash)) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    // Scope-free by necessity — the key is what establishes the scope, so there is
    // none to filter by yet. This is the same shape the agent gateway uses when it
    // turns a presented agent token into a host.
    const host = await this.hosts.getById(row.hostId);
    // A host row removed under a live key. The cascade normally takes the key with
    // it; failing closed here means a race cannot leave a credential pointing at
    // nothing.
    if (!host || !host.enabled) return null;
    // One write per authentication, not per tool call: the endpoint is stateless
    // and a busy agent would otherwise write on every request.
    // ⚠ FIRE-AND-FORGET, BUT NEVER UNCAUGHT. `void` on a rejected promise is an
    // unhandled rejection, and node's default for that is to TERMINATE — so a
    // transient write failure on this one non-essential column would take the API
    // down while the read that matters had already succeeded.
    //
    // ⚠ AND IT IS THROTTLED, because this endpoint is STATELESS: there is no session,
    // so every tool call authenticates and would otherwise write. A model polling
    // `host_detail` while an install finishes writes once every two seconds, forever.
    // A minute's resolution answers the only question the column is asked ("was this
    // credential used, and roughly when") at a fraction of the cost.
    this.touch(row.id, row.lastUsedAt);
    return { keyId: row.id, hostId: row.hostId, organizationId: host.organizationId, scopes: row.scopes };
  }

  /** Records use at minute resolution, and swallows a failure rather than crashing. */
  private touch(id: string, lastUsedAt: Date | null): void {
    if (lastUsedAt !== null && Date.now() - lastUsedAt.getTime() < TOUCH_INTERVAL_MS) return;
    void this.keys.update({ id }, { lastUsedAt: new Date() }).catch((error: unknown) => {
      this.logger.warn(`Failed to record MCP credential use id=${id}: ${String(error)}`);
    });
  }
}
