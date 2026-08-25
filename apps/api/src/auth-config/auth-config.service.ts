import type { SQL } from "bun";
import { AppException } from "@podosoft/podokit-contracts";
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

export type SocialProviderView = {
  id: string;
  enabled: boolean;
  clientId: string;
  redirectURI: string;
  hasSecret: boolean;
};

export type AuthConfigView = {
  social: Record<string, SocialProviderView>;
  catalog: ReadonlyArray<{ id: string; label: string }>;
  smtp: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    from: string;
    hasSecret: boolean;
  };
  server: {
    requireEmailVerification: boolean;
    requireSignupApproval: boolean;
    allowDelete: boolean;
    hibp: boolean;
    auditLog: boolean;
    sessionIdleTimeoutMinutes: number | null;
  };
};

export type ProviderUpdate = {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectURI?: string;
  delete?: boolean;
};

export type AuthConfigUpdate = {
  social?: Record<string, ProviderUpdate>;
  smtp?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    pass?: string;
    from?: string;
  };
  server?: {
    requireEmailVerification?: boolean;
    requireSignupApproval?: boolean;
    allowDelete?: boolean;
    hibp?: boolean;
    auditLog?: boolean;
    sessionIdleTimeoutMinutes?: number | null;
  };
};

interface AuthConfigRow {
  key: string;
  enabled: boolean;
  config: unknown;
  secret: string | null;
}

function object(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return {};
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function booleanField(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof source[key] === "boolean" ? source[key] : fallback;
}

export class AuthConfigService {
  constructor(private readonly sql: SQL) {}

  private async rows(): Promise<AuthConfigRow[]> {
    return this.sql<AuthConfigRow[]>`
      SELECT "key", "enabled", "config", "secret" FROM "auth_config"
    `;
  }

  private async row(key: string): Promise<AuthConfigRow | null> {
    const rows = await this.sql<AuthConfigRow[]>`
      SELECT "key", "enabled", "config", "secret"
      FROM "auth_config" WHERE "key" = ${key}
    `;
    return rows[0] ?? null;
  }

  private async upsert(row: AuthConfigRow): Promise<void> {
    const config = object(row.config);
    await this.sql`
      INSERT INTO "auth_config" ("key", "enabled", "config", "secret", "updatedAt")
      VALUES (${row.key}, ${row.enabled}, ${config}, ${row.secret}, CURRENT_TIMESTAMP)
      ON CONFLICT ("key") DO UPDATE SET
        "enabled" = EXCLUDED."enabled",
        "config" = EXCLUDED."config",
        "secret" = EXCLUDED."secret",
        "updatedAt" = CURRENT_TIMESTAMP
    `;
  }

  async describe(): Promise<AuthConfigView> {
    const rows = await this.rows();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const environment = envAuthConfig();
    const social: Record<string, SocialProviderView> = {};

    for (const row of rows) {
      if (!row.key.startsWith("social.")) continue;
      const id = row.key.slice("social.".length);
      if (!SUPPORTED_PROVIDER_IDS.has(id)) continue;
      const config = object(row.config);
      social[id] = {
        id,
        enabled: row.enabled,
        clientId: stringField(config, "clientId"),
        redirectURI: stringField(config, "redirectURI"),
        hasSecret: row.secret !== null && row.secret.length > 0,
      };
    }
    for (const [id, provider] of Object.entries(environment.social)) {
      if (social[id]) continue;
      social[id] = {
        id,
        enabled: provider.enabled,
        clientId: provider.clientId,
        redirectURI: provider.redirectURI ?? "",
        hasSecret: provider.clientSecret.length > 0,
      };
    }

    const smtp = byKey.get("smtp");
    const smtpConfig = object(smtp?.config);
    const serverConfig = object(byKey.get("server")?.config);
    return {
      social,
      catalog: SUPPORTED_SOCIAL_PROVIDERS,
      smtp: {
        enabled: smtp?.enabled ?? false,
        host: stringField(smtpConfig, "host"),
        port: typeof smtpConfig.port === "number" ? smtpConfig.port : 587,
        secure: booleanField(smtpConfig, "secure", false),
        user: stringField(smtpConfig, "user"),
        from: stringField(smtpConfig, "from"),
        hasSecret: smtp?.secret !== null && smtp?.secret !== undefined && smtp.secret.length > 0,
      },
      server: {
        requireEmailVerification: booleanField(
          serverConfig,
          "requireEmailVerification",
          environment.requireEmailVerification,
        ),
        requireSignupApproval: booleanField(
          serverConfig,
          "requireSignupApproval",
          environment.requireSignupApproval,
        ),
        allowDelete: booleanField(serverConfig, "allowDelete", environment.allowDelete),
        hibp: booleanField(serverConfig, "hibp", environment.hibp),
        auditLog: booleanField(serverConfig, "auditLog", environment.auditLog),
        sessionIdleTimeoutMinutes: resolveSessionIdleTimeoutMinutes(
          serverConfig.sessionIdleTimeoutMinutes,
          environment.sessionIdleTimeoutMinutes,
        ),
      },
    };
  }

  async update(update: AuthConfigUpdate): Promise<AuthConfigView> {
    for (const [id, provider] of Object.entries(update.social ?? {})) {
      if (!SUPPORTED_PROVIDER_IDS.has(id)) {
        throw new AppException("AUTH_PROVIDER_UNSUPPORTED", `Unsupported social provider: ${id}`, 400);
      }
      const key = socialKey(id);
      if (provider.delete) await this.sql`DELETE FROM "auth_config" WHERE "key" = ${key}`;
      else await this.upsertProvider(key, provider);
    }
    if (update.smtp) await this.upsertSmtp(update.smtp);
    if (update.server) await this.upsertServer(update.server);
    await refreshAuthNow();
    if (update.server?.sessionIdleTimeoutMinutes !== undefined) {
      await this.resetSessionExpirations(update.server.sessionIdleTimeoutMinutes);
    }
    return this.describe();
  }

  private async upsertProvider(key: string, update: ProviderUpdate): Promise<void> {
    const current = await this.row(key) ?? { key, enabled: false, config: {}, secret: null };
    const config = object(current.config);
    if (update.clientId !== undefined) config.clientId = update.clientId;
    if (update.redirectURI !== undefined) config.redirectURI = update.redirectURI;
    await this.upsert({
      ...current,
      enabled: update.enabled ?? current.enabled,
      config,
      secret: update.clientSecret ? encryptSecret(update.clientSecret) : current.secret,
    });
  }

  private async upsertSmtp(update: NonNullable<AuthConfigUpdate["smtp"]>): Promise<void> {
    const current = await this.row("smtp") ?? {
      key: "smtp",
      enabled: false,
      config: {},
      secret: null,
    };
    const config = object(current.config);
    for (const field of ["host", "port", "secure", "user", "from"] as const) {
      if (update[field] !== undefined) config[field] = update[field];
    }
    await this.upsert({
      ...current,
      enabled: update.enabled ?? current.enabled,
      config,
      secret: update.pass ? encryptSecret(update.pass) : current.secret,
    });
  }

  private async upsertServer(update: NonNullable<AuthConfigUpdate["server"]>): Promise<void> {
    if (
      update.sessionIdleTimeoutMinutes !== undefined
      && !isSessionIdleTimeoutMinutes(update.sessionIdleTimeoutMinutes)
    ) {
      throw new AppException(
        "SESSION_IDLE_TIMEOUT_INVALID",
        "Session idle timeout must be null or an integer from 5 to 10080 minutes",
        400,
      );
    }
    const current = await this.row("server") ?? {
      key: "server",
      enabled: true,
      config: {},
      secret: null,
    };
    const config = object(current.config);
    for (const field of [
      "requireEmailVerification",
      "requireSignupApproval",
      "allowDelete",
      "hibp",
      "auditLog",
    ] as const) {
      if (update[field] !== undefined) config[field] = update[field];
    }
    if (update.sessionIdleTimeoutMinutes !== undefined) {
      config.sessionIdleTimeoutMinutes = update.sessionIdleTimeoutMinutes;
    }
    await this.upsert({ ...current, config });
  }

  private async resetSessionExpirations(minutes: number | null): Promise<void> {
    const lifetimeSeconds = minutes === null ? DEFAULT_SESSION_LIFETIME_SECONDS : minutes * 60;
    await this.sql`
      UPDATE "session"
      SET "expiresAt" = CURRENT_TIMESTAMP + (${lifetimeSeconds} * INTERVAL '1 second'),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "expiresAt" > CURRENT_TIMESTAMP
    `;
  }
}
