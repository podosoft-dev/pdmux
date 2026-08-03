/**
 * Where the API is, and how a client's address is spelled on the way there.
 *
 * WHY THIS IS PLAIN JAVASCRIPT: the built web server (`apps/web/server.js`) proxies
 * the terminal WebSocket upgrade itself, and that entry runs OUTSIDE the SvelteKit
 * bundle — it cannot import TypeScript, `$lib`, or anything from `build/server`. The
 * two facts below are needed by both worlds, so they live in a module both can load.
 * Duplicating them is how "where is the backend" ends up answered twice, differently.
 */

/** @returns {string} Origin of the API, as seen from this process. */
export function backendBaseUrl() {
	return process.env.BACKEND_INTERNAL_URL ?? "http://localhost:5002";
}

/**
 * Normalize the resolved client IP for the forwarded header. better-auth stores IPv4
 * as-is but anonymizes IPv6 (masks the host bits), so an IPv6 loopback would be
 * recorded as "::" — map loopback to 127.0.0.1 for a clean local value, and unwrap
 * IPv4-mapped addresses.
 *
 * @param {string | undefined} address
 * @returns {string | undefined}
 */
export function normalizeClientIp(address) {
	if (!address) return undefined;
	if (address === "::1" || address === "::") return "127.0.0.1";
	if (address.startsWith("::ffff:")) return address.slice("::ffff:".length);
	return address;
}
