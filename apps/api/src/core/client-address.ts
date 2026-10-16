import { isIP } from "node:net";

/**
 * The request header that carries the client address the API resolved. The API
 * sets it on every request before any handler runs, replacing whatever a caller
 * sent, so Better Auth, audit entries, and application code read one address
 * that a caller cannot choose.
 */
export const CLIENT_ADDRESS_HEADER = "x-podokit-client-address";

export interface ClientAddressConfig {
  /** Reverse proxies in front of the API whose forwarded header is trusted; 0 trusts none. */
  trustedProxyHops: number;
  /** The lowercase header those proxies append the client address to. */
  header: string;
}

/** An IP address without its IPv4-mapped IPv6 prefix, or undefined when the value is not one. */
export function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
  return isIP(normalized) === 0 ? undefined : normalized;
}

/**
 * The caller's address. With no trusted proxy it is the socket peer. Otherwise
 * each trusted proxy appended one entry to the header, so the client is the
 * entry that many places left of the peer; entries further left were written
 * by the caller and are ignored. A chain shorter than the trusted hops, or a
 * malformed entry, falls back to the peer instead of trusting caller input.
 */
export function resolveClientAddress(
  headers: Headers,
  remoteAddress: string | undefined,
  config: ClientAddressConfig,
): string | undefined {
  const direct = normalizeIp(remoteAddress);
  if (config.trustedProxyHops === 0) return direct;
  const forwarded = headers.get(config.header)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  const chain = [...forwarded, direct ?? ""];
  if (chain.length <= config.trustedProxyHops) return direct;
  return normalizeIp(chain[chain.length - config.trustedProxyHops - 1]) ?? direct;
}

/**
 * Resolves a request's client address and records it in CLIENT_ADDRESS_HEADER,
 * replacing any value the caller sent. The API does this for every request
 * before a guard, Better Auth, or a handler reads the request.
 */
export function stampClientAddress(
  request: Request,
  remoteAddress: string | undefined,
  config: ClientAddressConfig,
): string | undefined {
  const address = resolveClientAddress(request.headers, remoteAddress, config);
  if (address) request.headers.set(CLIENT_ADDRESS_HEADER, address);
  else request.headers.delete(CLIENT_ADDRESS_HEADER);
  return address;
}

/** The address the API resolved for a request, as set in CLIENT_ADDRESS_HEADER. */
export function clientAddressOf(headers: Headers | undefined): string | undefined {
  return headers?.get(CLIENT_ADDRESS_HEADER) ?? undefined;
}
