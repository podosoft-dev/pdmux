import type { ProviderCapability, ProviderSelections } from "@podosoft/podokit-runtime";

const OPERATIONS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

const CORE_ROUTES = [
  "GET /health",
  "GET /health/ready",
];

const TEMPLATE_ROUTES: Record<string, string[]> = {
  todo: [
    "GET /todos",
    "GET /todos/{id}",
    "POST /todos",
    "PATCH /todos/{id}",
    "DELETE /todos/{id}",
  ],
};

const MODULE_ROUTES: Record<string, string[]> = {
  auth: [
    "GET /account/me",
    "GET /account/require-2fa",
    "GET /account/capabilities",
    "PUT /account/settings",
    "GET /account/auth-config",
    "PUT /account/auth-config",
    "POST /account/org-member",
    "GET /account/team-members",
    "GET /api/auth/get-session",
    "POST /api/auth/sign-in/email",
  ],
  "admin-dashboard": [
    "GET /site/settings",
    "PUT /site/settings",
    "POST /site/favicon",
    "GET /site/favicon",
    "POST /account/profile-image",
    "DELETE /account/profile-image",
    "GET /profile-images/{fileName}",
    "GET /admin/sessions",
    "DELETE /admin/sessions/{id}",
    "GET /admin/users",
  ],
  "api-key-auth": ["GET /machine/ping"],
  "audit-log": ["GET /audit-logs", "GET /audit-logs/actions"],
  analytics: [
    "GET /analytics/config",
    "GET /admin/analytics/config",
    "PUT /admin/analytics/config",
    "DELETE /admin/analytics/config/credentials",
    "POST /admin/analytics/config/test",
    "GET /admin/analytics/report",
    "GET /admin/analytics/realtime",
  ],
  blog: [
    "GET /blog",
    "POST /blog/images",
    "GET /blog/images/{id}",
    "GET /blog/mine",
    "GET /blog/manage/{slug}",
    "GET /blog/{postRef}/comments",
    "GET /blog/{postRef}",
    "POST /blog",
    "PATCH /blog/{postRef}",
    "DELETE /blog/{postRef}",
    "POST /blog/{postRef}/comments",
    "PATCH /blog/comments/{id}",
    "DELETE /blog/comments/{id}",
    "GET /admin/blog",
    "GET /admin/blog/{id}",
    "POST /admin/blog",
    "PATCH /admin/blog/{id}",
    "DELETE /admin/blog/{id}",
  ],
  bullmq: ["POST /jobs", "GET /jobs/{id}"],
  "file-upload": [
    "POST /files",
    "GET /files/{key}/url",
    "POST /files/uploads",
    "GET /files/uploads/{id}",
    "PUT /files/uploads/{id}/parts/{partNumber}",
    "POST /files/uploads/{id}/complete",
    "DELETE /files/uploads/{id}",
  ],
  "job-progress": ["POST /progress"],
  "jobs-local": ["POST /jobs", "GET /jobs/{id}"],
  "object-storage-local": [
    "GET /files/content/*",
    "PUT /storage/{key}",
    "GET /storage/{key}",
    "GET /storage/{key}/presigned",
  ],
  "object-storage-s3": [
    "PUT /storage/{key}",
    "GET /storage/{key}",
    "GET /storage/{key}/presigned",
  ],
  redis: ["PUT /cache/{key}", "GET /cache/{key}"],
  sse: ["GET /events/stream", "POST /events"],
};

/**
 * The provider each provider module implements. Such a module registers its
 * routes only while its provider is selected, so an app may keep, say, both
 * object-storage modules installed and serve the routes of one.
 */
export const MODULE_PROVIDERS: Readonly<Record<string, readonly [ProviderCapability, string]>> = {
  bullmq: ["jobs", "bullmq"],
  "cache-memory": ["cache", "memory"],
  "events-memory": ["events", "memory"],
  "events-redis": ["events", "redis"],
  "jobs-local": ["jobs", "local"],
  "object-storage-local": ["object-storage", "local"],
  "object-storage-s3": ["object-storage", "s3"],
  redis: ["cache", "redis"],
};

interface RuntimeRoute {
  method?: string;
  path: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function runtimeRoutes(value: unknown): RuntimeRoute[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((route) => {
    const { path, method } = record(route);
    if (typeof path !== "string") return [];
    return [typeof method === "string" ? { method, path } : { path }];
  });
}

/** "METHOD /path" with OpenAPI parameters, so ":id" and "{id}" compare equal. */
export function normalizeApiRoute(route: string): string {
  const [method = "", path = ""] = route.trim().split(/\s+/, 2);
  const openApiPath = path
    .split("/")
    .map((segment) => segment.startsWith(":") ? `{${segment.slice(1).replace(/[?*]$/, "")}}` : segment)
    .join("/");
  return `${method.toUpperCase()} ${openApiPath}`;
}

/** The operations an Elysia app registers, as normalized "METHOD /path" entries. */
export function registeredApiRoutes(routes: unknown): Set<string> {
  const registered = new Set<string>();
  for (const route of runtimeRoutes(routes)) {
    if (route.method) registered.add(normalizeApiRoute(`${route.method} ${route.path}`));
  }
  return registered;
}

/**
 * Fails unless every application route is both registered and documented.
 * `expected` comes from APP_DOCUMENTED_ROUTES in api-contract.extensions.ts.
 */
export function assertApplicationRoutes(document: unknown, routes: unknown, expected: readonly string[]): void {
  const documented = documentedApiRoutes(document);
  const registered = registeredApiRoutes(routes);
  const problems = [...new Set(expected.map(normalizeApiRoute))].sort().flatMap((route) => [
    ...(registered.has(route) ? [] : [`${route} is not registered`]),
    ...(documented.has(route) ? [] : [`${route} is missing from the OpenAPI document`]),
  ]);
  if (problems.length > 0) {
    throw new Error(`Application API contract failed:\n${problems.join("\n")}`);
  }
}

/**
 * Memoirist stores one parameter name at each structural radix-tree position.
 * Routes such as `/hosts/:id` and `/hosts/:hostId/files` therefore cannot share
 * an Elysia application even though their complete paths differ.
 */
export function assertConsistentRouteParameters(routes: unknown): void {
  const names = new Map<string, { name: string; path: string }>();
  const conflicts: string[] = [];

  for (const route of runtimeRoutes(routes)) {
    let position = "";
    for (const segment of route.path.split("/").filter(Boolean)) {
      const match = /^:([^?*]+)/.exec(segment);
      position += `/${match ? ":" : segment}`;
      const name = match?.[1];
      if (!name) continue;
      const existing = names.get(position);
      if (!existing) {
        names.set(position, { name, path: route.path });
      } else if (existing.name !== name) {
        conflicts.push(
          `${route.path} uses :${name}; ${existing.path} uses :${existing.name} at ${position}`,
        );
      }
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `API routes at the same structural position must use one parameter name:\n${conflicts.join("\n")}`,
    );
  }
}

export function documentedApiRoutes(document: unknown): Set<string> {
  const routes = new Set<string>();
  for (const [path, operations] of Object.entries(record(record(document).paths))) {
    for (const method of Object.keys(record(operations))) {
      if (OPERATIONS.has(method.toLowerCase())) routes.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
}

/**
 * The routes the template and the installed modules serve. A provider module
 * counts only when `providers`, the app's PROVIDERS, selects its provider.
 */
export function expectedApiRoutes(
  template: string,
  modules: string[],
  providers: Readonly<ProviderSelections>,
): Set<string> {
  const routes = new Set(CORE_ROUTES);
  for (const route of TEMPLATE_ROUTES[template] ?? []) routes.add(route);
  for (const module of modules) {
    const provider = MODULE_PROVIDERS[module];
    if (provider && providers[provider[0]] !== provider[1]) continue;
    for (const route of MODULE_ROUTES[module] ?? []) routes.add(route);
  }
  return routes;
}

export function missingApiRoutes(
  document: unknown,
  template: string,
  modules: string[],
  providers: Readonly<ProviderSelections>,
): string[] {
  const documented = documentedApiRoutes(document);
  return [...expectedApiRoutes(template, modules, providers)]
    .filter((route) => !documented.has(route))
    .sort();
}

export function assertApiContract(
  document: unknown,
  template: string,
  modules: string[],
  providers: Readonly<ProviderSelections>,
): void {
  const missing = missingApiRoutes(document, template, modules, providers);
  if (missing.length > 0) {
    throw new Error(`OpenAPI contract is missing routes:\n${missing.join("\n")}`);
  }
}
