import { resolve, join } from "node:path";

export function desktopApiProfile(root) {
  const base = join(root, "src");
  const replacements = new Map([
    ["auth/auth.ts", "auth.ts"], ["auth/auth.module.ts", "auth.module.ts"],
    ["auth/postgres-pool.ts", "postgres-pool.ts"],
    ["runtime/jobs.ts", "jobs.ts"], ["admin.module.ts", "site.module.ts"], ["audit/audit.module.ts", "audit.module.ts"],
    ...["storage/storage.module.ts", "redis/redis.module.ts", "api-key/api-key.module.ts", "events-provider-redis/events-redis.module.ts", "jobs/jobs.module.ts", "logging/logging.module.ts"].map(path => [path, "excluded-modules.ts"]),
  ].map(([source, target]) => [join(base, source), join(base, "desktop/profile", target)]));
  return {
    name: "pdmux-desktop-services",
    setup(build) {
      build.onResolve({ filter: /^\..*\/(?:postgres-pool|jobs|auth(?:\.module)?|admin\.module|audit\.module|storage\.module|redis\.module|api-key\.module|events-redis\.module|jobs\.module|logging\.module)(?:\.ts)?$/ }, args => {
        const file = resolve(args.resolveDir, args.path.endsWith(".ts") ? args.path : `${args.path}.ts`);
        const target = replacements.get(file);
        return target ? { path: target } : undefined;
      });
    },
  };
}

export const desktopRouteExcluded = path => /^(?:\(admin\)|\(auth\)|\(app\)|oauth2|setup-2fa|desktop\/connect)(?:\/|$)/.test(path) || /^\(shell\)\/account(?:\/|$)/.test(path);
