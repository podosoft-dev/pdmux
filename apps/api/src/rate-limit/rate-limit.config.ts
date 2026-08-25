import { isIP } from "node:net";

export interface RateLimitConfig {
  keyPrefix: string;
  ttlSeconds: number;
  limit: number;
  authTtlSeconds: number;
  authLimit: number;
  runtimeLimit: number;
  trustedProxyHops: number;
  proxyHeader: string;
  storageTimeoutMs: number;
  unavailableRetryAfterSeconds: number;
}

function keyPrefix(value: string | undefined): string {
  const normalized = (value || "podokit:rate-limit").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(normalized)) {
    throw new Error(
      "RATE_LIMIT_KEY_PREFIX must be 1-128 characters using letters, numbers, colons, underscores, or hyphens",
    );
  }
  return normalized;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function headerName(value: string | undefined): string {
  const normalized = (value || "x-forwarded-for").trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(normalized)) {
    throw new Error("RATE_LIMIT_PROXY_HEADER must be a valid HTTP header name");
  }
  return normalized;
}

export function rateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    keyPrefix: keyPrefix(env.RATE_LIMIT_KEY_PREFIX),
    ttlSeconds: positiveInteger("RATE_LIMIT_TTL", env.RATE_LIMIT_TTL, 60),
    limit: positiveInteger("RATE_LIMIT_MAX", env.RATE_LIMIT_MAX, 300),
    authTtlSeconds: positiveInteger(
      "RATE_LIMIT_AUTH_TTL",
      env.RATE_LIMIT_AUTH_TTL,
      60,
    ),
    authLimit: positiveInteger("RATE_LIMIT_AUTH_MAX", env.RATE_LIMIT_AUTH_MAX, 20),
    runtimeLimit: positiveInteger(
      "RATE_LIMIT_RUNTIME_MAX",
      env.RATE_LIMIT_RUNTIME_MAX,
      1000,
    ),
    trustedProxyHops: nonNegativeInteger(
      "RATE_LIMIT_TRUSTED_PROXY_HOPS",
      env.RATE_LIMIT_TRUSTED_PROXY_HOPS,
      0,
    ),
    proxyHeader: headerName(env.RATE_LIMIT_PROXY_HEADER),
    storageTimeoutMs: positiveInteger(
      "RATE_LIMIT_STORAGE_TIMEOUT_MS",
      env.RATE_LIMIT_STORAGE_TIMEOUT_MS,
      1000,
    ),
    unavailableRetryAfterSeconds: positiveInteger(
      "RATE_LIMIT_UNAVAILABLE_RETRY_AFTER",
      env.RATE_LIMIT_UNAVAILABLE_RETRY_AFTER,
      1,
    ),
  };
}

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("::ffff:")
    ? trimmed.slice("::ffff:".length)
    : trimmed;
  return isIP(normalized) === 0 ? undefined : normalized;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (!headers || typeof headers !== "object") return undefined;
  const value = (headers as Record<string, unknown>)[name];
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings.join(",") : undefined;
}

export function clientAddressFromProxy(
  headers: unknown,
  remoteAddress: string | undefined,
  config: Pick<RateLimitConfig, "proxyHeader" | "trustedProxyHops">,
): string {
  const direct = normalizeIp(remoteAddress) ?? "unknown";
  if (config.trustedProxyHops === 0) return direct;

  const forwarded = headerValue(headers, config.proxyHeader)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  const chain = [...forwarded, direct];
  if (chain.length <= config.trustedProxyHops) return direct;

  const selected = chain[chain.length - config.trustedProxyHops - 1];
  return normalizeIp(selected) ?? direct;
}
