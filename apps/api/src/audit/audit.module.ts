import { AUTH } from "../auth/auth.module";
import {
  DATABASE,
  LOGGER,
  type AppPlugin,
  type PodokitModule,
  type ServiceKey,
} from "../core/services";
import { auditEnabled } from "./audit-enabled";
import { auditRoutes } from "./audit.routes";
import { AuditService, parseRetentionDays } from "./audit.service";

export const AUDIT = Symbol("audit") as ServiceKey<AuditService>;

const auditPlugin: AppPlugin = ({ services }) => {
  const auth = services.resolve(AUTH);
  return auditRoutes(services.resolve(AUDIT), (request) => auth.requireAdmin(request));
};

export const auditModule: PodokitModule = {
  name: "audit-log",
  configure: (_env, services): void => {
    const database = services.resolve(DATABASE);
    const audit = new AuditService(database.sql, {
      dialect: database.provider,
      enabled: auditEnabled,
      // Resolved on use: the logging module may replace the logger after this point.
      logger: { warn: (details, message) => services.resolve(LOGGER).warn(details, message) },
      retention: { days: parseRetentionDays(process.env.AUDIT_LOG_RETENTION_DAYS) },
    });
    services.register(AUDIT, audit, () => audit.close());
    services.onStart(() => {
      audit.connect();
      // Not awaited: the toggle read may wait for the database, which startup does not.
      void audit.warnIfDisabled();
    });
  },
  plugin: auditPlugin,
};
