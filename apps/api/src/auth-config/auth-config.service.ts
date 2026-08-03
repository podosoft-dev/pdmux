import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuthConfigRow } from "./auth-config.entity";
import {
  DEFAULT_SESSION_LIFETIME_SECONDS,
  encryptSecret,
  envAuthConfig,
  isSessionIdleTimeoutMinutes,
  resolveSessionIdleTimeoutMinutes,
  socialKey,
  SUPPORTED_PROVIDER_IDS,
  SUPPORTED_SOCIAL_PROVIDERS,
} from "@podosoft/podokit-auth";
import { refreshAuthNow } from "../auth/auth-provider";

/** One configured social provider as shown to the admin (no secret — just a
 *  `hasSecret` flag). */
export type SocialProviderView = { id: string; enabled: boolean; clientId: string; redirectURI: string; hasSecret: boolean };

/** Admin-facing view — non-secret fields plus a `hasSecret` flag. Never exposes
 *  the stored client secret / SMTP password. Social providers are dynamic: the
 *  map holds one entry per configured provider (google, github, apple, …). */
export type AuthConfigView = {
  social: Record<string, SocialProviderView>;
  /** Catalog of addable providers (id + display label) for the "add provider" picker. */
  catalog: ReadonlyArray<{ id: string; label: string }>;
  smtp: { enabled: boolean; host: string; port: number; secure: boolean; user: string; from: string; hasSecret: boolean };
  server: {
    requireEmailVerification: boolean;
    requireSignupApproval: boolean;
    allowDelete: boolean;
    hibp: boolean;
    auditLog: boolean;
    sessionIdleTimeoutMinutes: number | null;
  };
};

type ProviderUpdate = { enabled?: boolean; clientId?: string; clientSecret?: string; redirectURI?: string; delete?: boolean };
export type AuthConfigUpdate = {
  /** Per-provider upsert (keyed by provider id); `{ delete: true }` removes it. */
  social?: Record<string, ProviderUpdate>;
  smtp?: { enabled?: boolean; host?: string; port?: number; secure?: boolean; user?: string; pass?: string; from?: string };
  server?: {
    requireEmailVerification?: boolean;
    requireSignupApproval?: boolean;
    allowDelete?: boolean;
    hibp?: boolean;
    auditLog?: boolean;
    sessionIdleTimeoutMinutes?: number | null;
  };
};

@Injectable()
export class AuthConfigService {
  constructor(@InjectRepository(AuthConfigRow) private readonly repo: Repository<AuthConfigRow>) {}

  async describe(): Promise<AuthConfigView> {
    const rows = await this.repo.find();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const env = envAuthConfig();

    const social: Record<string, SocialProviderView> = {};
    for (const row of rows) {
      if (!row.key.startsWith("social.")) continue;
      const id = row.key.slice("social.".length);
      if (!SUPPORTED_PROVIDER_IDS.has(id)) continue;
      const c = (row.config ?? {}) as { clientId?: string; redirectURI?: string };
      social[id] = { id, enabled: row.enabled, clientId: c.clientId ?? "", redirectURI: c.redirectURI ?? "", hasSecret: !!row.secret };
    }
    // Surface env-configured providers (google/github) that have no DB row yet, so
    // the admin sees them as already-active rather than missing.
    for (const [id, p] of Object.entries(env.social)) {
      if (!social[id]) social[id] = { id, enabled: p.enabled, clientId: p.clientId, redirectURI: p.redirectURI ?? "", hasSecret: !!p.clientSecret };
    }

    const smtpRow = byKey.get("smtp");
    const smtpC = (smtpRow?.config ?? {}) as { host?: string; port?: number; secure?: boolean; user?: string; from?: string };
    const serverRow = byKey.get("server");
    const serverC = (serverRow?.config ?? {}) as {
      requireEmailVerification?: boolean;
      requireSignupApproval?: boolean;
      allowDelete?: boolean;
      hibp?: boolean;
      auditLog?: boolean;
      sessionIdleTimeoutMinutes?: number | null;
    };
    return {
      social,
      catalog: SUPPORTED_SOCIAL_PROVIDERS,
      smtp: {
        enabled: smtpRow?.enabled ?? false,
        host: smtpC.host ?? "",
        port: smtpC.port ?? 587,
        secure: smtpC.secure ?? false,
        user: smtpC.user ?? "",
        from: smtpC.from ?? "",
        hasSecret: !!smtpRow?.secret,
      },
      server: {
        requireEmailVerification: serverC.requireEmailVerification ?? env.requireEmailVerification,
        requireSignupApproval: serverC.requireSignupApproval ?? env.requireSignupApproval,
        allowDelete: serverC.allowDelete ?? env.allowDelete,
        hibp: serverC.hibp ?? env.hibp,
        auditLog: serverC.auditLog ?? env.auditLog,
        sessionIdleTimeoutMinutes: resolveSessionIdleTimeoutMinutes(
          serverC.sessionIdleTimeoutMinutes,
          env.sessionIdleTimeoutMinutes,
        ),
      },
    };
  }

  async update(dto: AuthConfigUpdate): Promise<AuthConfigView> {
    for (const [id, u] of Object.entries(dto.social ?? {})) {
      if (!SUPPORTED_PROVIDER_IDS.has(id)) throw new BadRequestException(`Unsupported social provider: ${id}`);
      if (u.delete) await this.repo.delete({ key: socialKey(id) });
      else await this.upsertProvider(socialKey(id), u);
    }
    if (dto.smtp) await this.upsertSmtp(dto.smtp);
    if (dto.server) await this.upsertServer(dto.server);
    await refreshAuthNow();
    if (dto.server?.sessionIdleTimeoutMinutes !== undefined) {
      await this.resetSessionExpirations(dto.server.sessionIdleTimeoutMinutes);
    }
    return this.describe();
  }

  private async upsertProvider(key: string, u: ProviderUpdate): Promise<void> {
    const row = (await this.repo.findOneBy({ key })) ?? this.repo.create({ key, enabled: false, config: {}, secret: null });
    const config = { ...(row.config as { clientId?: string; redirectURI?: string }) };
    if (u.clientId !== undefined) config.clientId = u.clientId;
    if (u.redirectURI !== undefined) config.redirectURI = u.redirectURI;
    if (u.enabled !== undefined) row.enabled = u.enabled;
    // Replace the secret only when a non-empty value is supplied; otherwise keep it.
    if (u.clientSecret) row.secret = encryptSecret(u.clientSecret);
    row.config = config;
    await this.repo.save(row);
  }

  private async upsertSmtp(u: NonNullable<AuthConfigUpdate["smtp"]>): Promise<void> {
    const row = (await this.repo.findOneBy({ key: "smtp" })) ?? this.repo.create({ key: "smtp", enabled: false, config: {}, secret: null });
    const config = { ...(row.config as Record<string, unknown>) };
    for (const f of ["host", "port", "secure", "user", "from"] as const) if (u[f] !== undefined) config[f] = u[f];
    if (u.enabled !== undefined) row.enabled = u.enabled;
    if (u.pass) row.secret = encryptSecret(u.pass);
    row.config = config;
    await this.repo.save(row);
  }

  private async upsertServer(u: NonNullable<AuthConfigUpdate["server"]>): Promise<void> {
    if (u.sessionIdleTimeoutMinutes !== undefined && !isSessionIdleTimeoutMinutes(u.sessionIdleTimeoutMinutes)) {
      throw new BadRequestException("Session idle timeout must be null or an integer from 5 to 10080 minutes");
    }
    const row = (await this.repo.findOneBy({ key: "server" })) ?? this.repo.create({ key: "server", enabled: true, config: {}, secret: null });
    const config = { ...(row.config as Record<string, unknown>) };
    for (const f of ["requireEmailVerification", "requireSignupApproval", "allowDelete", "hibp", "auditLog"] as const) {
      if (u[f] !== undefined) config[f] = u[f];
    }
    if (u.sessionIdleTimeoutMinutes !== undefined) {
      config.sessionIdleTimeoutMinutes = u.sessionIdleTimeoutMinutes;
    }
    row.config = config;
    await this.repo.save(row);
  }

  private async resetSessionExpirations(minutes: number | null): Promise<void> {
    const lifetimeSeconds = minutes === null
      ? DEFAULT_SESSION_LIFETIME_SECONDS
      : minutes * 60;
    await this.repo.manager.query(
      `UPDATE "session"
       SET "expiresAt" = CURRENT_TIMESTAMP + ($1 * INTERVAL '1 second'),
           "updatedAt" = CURRENT_TIMESTAMP
       WHERE "expiresAt" > CURRENT_TIMESTAMP`,
      [lifetimeSeconds],
    );
  }
}
