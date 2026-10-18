import { DATABASE, LOGGER, type PodokitModule, type ServiceKey } from "../../core/services";
import { AuditService, parseRetentionDays } from "../../audit/audit.service";

export const AUDIT = Symbol("audit") as ServiceKey<AuditService>;
export const auditModule: PodokitModule = {
  name: "desktop-audit",
  configure: (_env, services): void => {
    const database = services.resolve(DATABASE);
    const audit = new AuditService(database.sql, {
      dialect: database.provider, enabled: async () => true,
      logger: { warn: (details, message) => services.resolve(LOGGER).warn(details, message) },
      retention: { days: parseRetentionDays(process.env.AUDIT_LOG_RETENTION_DAYS) },
    });
    services.register(AUDIT, audit, () => audit.close());
    services.onStart(() => audit.connect());
  },
};
