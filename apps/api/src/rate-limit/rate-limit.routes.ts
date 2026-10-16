import type {
  RateLimitProfile,
  RateLimitRoute,
  RateLimitRouteRegistry,
} from "@podosoft/podokit-runtime";
import type { RateLimitConfig } from "./rate-limit.config";

/** A budget with its window resolved, or "exempt". */
export type ResolvedRateLimitProfile = Required<RateLimitProfile> | "exempt";

/** A literal path segment, or null for a `:name` parameter. */
type Segment = string | null;

interface RouteEntry {
  method?: string;
  segments: Segment[];
  profile: ResolvedRateLimitProfile;
}

const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const METHOD = /^[A-Z]+$/;
const PARAMETER = /^:[A-Za-z_][A-Za-z0-9_]*$/;

function positiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function parsePrefix(prefix: string): Segment[] {
  if (!prefix.startsWith("/") || /[?#\s]/.test(prefix) || prefix.includes("//")) {
    throw new Error(`Rate limit path prefix must be an absolute path: ${prefix}`);
  }
  if (prefix.includes("*")) {
    throw new Error(`Rate limit path prefix takes ":name" parameters, not wildcards: ${prefix}`);
  }
  const base = prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return base === "/"
    ? []
    : base.slice(1).split("/").map((segment) => {
        if (segment === "." || segment === "..") {
          throw new Error(`Rate limit path prefix must not contain "." or ".." segments: ${prefix}`);
        }
        if (!segment.startsWith(":")) return segment;
        if (!PARAMETER.test(segment)) {
          throw new Error(`Rate limit path parameter must be ":" and a name such as ":hostId": ${prefix}`);
        }
        return null;
      });
}

/** Whole-segment prefix match; a parameter matches one non-empty segment. */
function covers(segments: Segment[], path: string[]): boolean {
  return (
    path.length >= segments.length &&
    segments.every((segment, index) => (segment === null ? path[index] !== "" : segment === path[index]))
  );
}

/**
 * Below zero when `a` is more specific: more segments, then, from the left, a
 * literal segment before a parameter.
 */
function compareSpecificity(a: Segment[], b: Segment[]): number {
  if (a.length !== b.length) return b.length - a.length;
  for (let index = 0; index < a.length; index += 1) {
    const literalA = a[index] !== null;
    if (literalA !== (b[index] !== null)) return literalA ? -1 : 1;
  }
  return 0;
}

/**
 * Route profiles for the rate limiter. The built-in authentication and runtime
 * budgets are registered here too, so a module's more specific route takes
 * precedence over them by the same rule as over any other route.
 */
export class RateLimitRoutes implements RateLimitRouteRegistry {
  private readonly entries: RouteEntry[] = [];
  private readonly budgets = new Map<string, Required<RateLimitProfile>>();

  constructor(private readonly defaultTtlSeconds: number) {}

  register(route: RateLimitRoute): void {
    const method = route.method?.toUpperCase();
    if (method !== undefined && !METHOD.test(method)) {
      throw new Error(`Rate limit route method is invalid: ${route.method}`);
    }
    const segments = parsePrefix(route.pathPrefix);
    const profile = route.profile === "exempt" ? "exempt" : this.budget(route.profile);
    this.entries.push({ ...(method ? { method } : {}), segments, profile });
  }

  /** The most specific registered profile for a request, if any route matches. */
  resolve(method: string, path: string): ResolvedRateLimitProfile | undefined {
    const pathSegments = path.split("/").slice(1);
    let best: RouteEntry | undefined;
    for (const entry of this.entries) {
      if (entry.method !== undefined && entry.method !== method) continue;
      if (!covers(entry.segments, pathSegments)) continue;
      // The more specific prefix wins, then a route with a method, then the later one.
      const order = best ? compareSpecificity(entry.segments, best.segments) : -1;
      if (order < 0 || (order === 0 && (entry.method !== undefined || best?.method === undefined))) {
        best = entry;
      }
    }
    return best?.profile;
  }

  private budget(profile: RateLimitProfile): Required<RateLimitProfile> {
    if (!PROFILE_NAME.test(profile.name)) {
      throw new Error(`Rate limit profile name must be 1-64 letters, digits, "_" or "-": ${profile.name}`);
    }
    positiveInteger(profile.limit, `Rate limit profile ${profile.name} limit`);
    positiveInteger(profile.ttlSeconds, `Rate limit profile ${profile.name} ttlSeconds`);
    const budget = {
      name: profile.name,
      limit: profile.limit,
      ttlSeconds: profile.ttlSeconds ?? this.defaultTtlSeconds,
    };
    const existing = this.budgets.get(budget.name);
    if (existing && (existing.limit !== budget.limit || existing.ttlSeconds !== budget.ttlSeconds)) {
      throw new Error(
        `Rate limit profile ${budget.name} is already registered with a limit of ${existing.limit} per ${existing.ttlSeconds}s`,
      );
    }
    this.budgets.set(budget.name, budget);
    return budget;
  }
}

/** The general budget, which applies when no route matches. */
export function generalProfile(config: RateLimitConfig): Required<RateLimitProfile> {
  return { name: "general", limit: config.limit, ttlSeconds: config.ttlSeconds };
}

/**
 * The built-in profiles. Authentication writes get the strict auth budget,
 * while administrator reads (the admin pages read users through Better Auth)
 * stay on the general budget, and session and public site-settings reads get
 * the higher runtime budget.
 */
export function defaultRateLimitRoutes(config: RateLimitConfig): RateLimitRoutes {
  const routes = new RateLimitRoutes(config.ttlSeconds);
  const runtime = { name: "runtime", limit: config.runtimeLimit, ttlSeconds: config.ttlSeconds };
  routes.register({ pathPrefix: "/", profile: generalProfile(config) });
  routes.register({
    pathPrefix: "/api/auth",
    profile: { name: "auth", limit: config.authLimit, ttlSeconds: config.authTtlSeconds },
  });
  routes.register({ method: "GET", pathPrefix: "/api/auth/admin", profile: generalProfile(config) });
  routes.register({ method: "GET", pathPrefix: "/api/auth/get-session", profile: runtime });
  routes.register({ method: "GET", pathPrefix: "/site/settings", profile: runtime });
  return routes;
}
