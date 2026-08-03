/**
 * The WebSocket upgrades, proxied by the web server itself.
 *
 * WHY THIS EXISTS: a WebSocket upgrade is the one thing a SvelteKit server route
 * cannot serve — `+server.ts` handlers answer HTTP requests and never see an
 * `upgrade` event, and the `/api/*` proxy in front of the API is HTTP-only for the
 * same reason. Development had a Vite proxy for `/terminal/ws`, so the whole terminal
 * feature worked there and then died silently on a built deployment: the adapter's
 * server routed the upgrade into SvelteKit, which answered 303 and left every pane
 * saying "reconnecting" forever. Requiring operators to add a bespoke reverse-proxy
 * rule for a core feature is not a deployment story, so the app does it itself.
 *
 * `/agent/ws` is here for the same reason: an agent installed on some machine is
 * pointed at the public origin — the one URL an operator has — which serves the web
 * app. Without this relay the agent's dial lands on the adapter and never reaches the
 * API's gateway, so `pdmux-agent doctor` reports `connectivity FAIL` and the one-line
 * install cannot work at all.
 *
 * ⚠ EXACTLY TWO PATHS ARE FORWARDED (`RELAY_PATHS`). Anything else that asks to
 * upgrade is destroyed, not proxied: a relay that forwards any path is an open tunnel
 * to every private route on the API, reachable from the public origin without a
 * session. Adding a third path is a security decision, not a routing tweak.
 *
 * The transport is injected (`connect`) so the decisions here — which upgrades are
 * forwarded, what the API is told about the client, what the browser is told when the
 * handshake fails — are testable without a socket.
 */
import http from "node:http";
import https from "node:https";
import { AGENT_WS_PATH, TERMINAL_WS_PATH } from "@pdmux/protocol";
import { backendBaseUrl, normalizeClientIp } from "./backend-target.js";

/**
 * The only upgrade targets that reach the API, matched whole — never as a prefix,
 * a wildcard or a pattern. Both are authorised upstream at handshake time (the
 * browser's session cookie for the terminal, the agent key header for the agent),
 * which is exactly why nothing else may pass: an unlisted path would arrive at the
 * API carrying whatever the caller sent, with no route of ours having judged it.
 *
 * @type {ReadonlySet<string>}
 */
const RELAY_PATHS = new Set([TERMINAL_WS_PATH, AGENT_WS_PATH]);

/**
 * The socket surface this proxy uses: a duplex stream, plus the four things a TCP
 * socket adds that matter here. Typed this way rather than as `net.Socket` so a unit
 * test can drive it with a `PassThrough` — real stream semantics, no network.
 *
 * @typedef {import("node:stream").Duplex & {
 *   setNoDelay?: (value: boolean) => unknown,
 *   setKeepAlive?: (enable: boolean, initialDelay?: number) => unknown,
 *   setTimeout?: (ms: number) => unknown,
 *   remoteAddress?: string,
 *   encrypted?: boolean,
 * }} ProxySocket
 */

/** @typedef {Record<string, string | string[] | undefined>} Headers */

/** @typedef {{ kind: "proxy", path: string } | { kind: "reject", reason: string }} UpgradeDecision */

/**
 * @typedef {object} UpstreamOptions
 * @property {string} protocol
 * @property {string} hostname
 * @property {string} port
 * @property {string} path
 * @property {Headers} headers
 */

/**
 * @typedef {object} UpstreamHooks
 * @property {(status: number, headers: Headers, socket: ProxySocket, head: Uint8Array | null) => void} onUpgrade
 * @property {(status: number, statusMessage: string, headers: Headers) => void} onResponse
 * @property {(reason: string) => void} onError
 */

/** @typedef {(options: UpstreamOptions, hooks: UpstreamHooks) => { abort: () => void }} Connect */

/**
 * Should this upgrade be forwarded, and under which (normalized) path?
 *
 * The path comes back re-serialised from `URL` rather than echoed, so a target that
 * only *looks* like a relay path after resolving `..` cannot reach anything else. An
 * absolute or protocol-relative target is refused outright — a request-target that
 * carries its own authority has no business in a same-origin upgrade. The pathname is
 * then compared whole against `RELAY_PATHS`, so `/agent/wsx` or `/terminal/ws/` are
 * simply not on the list.
 *
 * @param {string | undefined} url `req.url`, an origin-form request target
 * @param {Headers} headers
 * @returns {UpgradeDecision}
 */
export function decideUpgrade(url, headers) {
	const upgrade = String(headers.upgrade ?? "").toLowerCase();
	if (upgrade !== "websocket") return { kind: "reject", reason: "not a websocket upgrade" };
	if (!url || !url.startsWith("/") || url.startsWith("//")) {
		return { kind: "reject", reason: "not an origin-form request target" };
	}
	let parsed;
	try {
		parsed = new URL(url, "http://upgrade.invalid");
	} catch {
		return { kind: "reject", reason: "unparsable request target" };
	}
	if (!RELAY_PATHS.has(parsed.pathname)) return { kind: "reject", reason: "not a relay path" };
	return { kind: "proxy", path: `${parsed.pathname}${parsed.search}` };
}

/**
 * What the API is told about the request.
 *
 * The handshake headers (`upgrade`, `connection`, `sec-websocket-*`) and the session
 * cookie go through untouched — the API authorises the socket at upgrade time from
 * that cookie, so losing it turns every terminal into a 401. The `x-forwarded-*` trio
 * is appended rather than replaced: behind another proxy we are one hop in a chain,
 * and overwriting it would report the wrong client to the API's address logic.
 *
 * @param {Headers} headers
 * @param {ProxySocket} socket
 * @returns {Headers}
 */
export function upstreamHeaders(headers, socket) {
	/** @type {Headers} */
	const forwarded = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (name === "x-forwarded-for" || name === "x-forwarded-proto" || name === "x-forwarded-host") continue;
		forwarded[name] = value;
	}

	const client = normalizeClientIp(socket.remoteAddress);
	const chain = [headers["x-forwarded-for"], client]
		.flat()
		.filter((entry) => typeof entry === "string" && entry.length > 0);
	if (chain.length > 0) forwarded["x-forwarded-for"] = chain.join(", ");

	const proto = headers["x-forwarded-proto"] ?? (socket.encrypted ? "https" : "http");
	forwarded["x-forwarded-proto"] = proto;
	const host = headers["x-forwarded-host"] ?? headers.host;
	if (host !== undefined) forwarded["x-forwarded-host"] = host;

	return forwarded;
}

/**
 * Where the upgrade is sent, and with what.
 *
 * @param {string} path
 * @param {Headers} headers
 * @returns {UpstreamOptions}
 */
export function upstreamOptions(path, headers) {
	const base = new URL(backendBaseUrl());
	return {
		protocol: base.protocol,
		hostname: base.hostname,
		port: base.port || (base.protocol === "https:" ? "443" : "80"),
		path,
		headers,
	};
}

/**
 * Serialise a status line plus headers into a raw HTTP head.
 *
 * @param {string} statusLine
 * @param {Headers} headers
 * @returns {string}
 */
function rawHead(statusLine, headers) {
	const lines = [statusLine];
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
		else lines.push(`${name}: ${value}`);
	}
	return `${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * Terminal traffic is many tiny frames, so Nagle's algorithm would add latency to
 * every keystroke, and the default socket timeout would cut an idle-but-attached pane.
 *
 * @param {ProxySocket} socket
 */
function tune(socket) {
	socket.setTimeout?.(0);
	socket.setNoDelay?.(true);
	socket.setKeepAlive?.(true, 0);
}

/** The real transport: one upstream HTTP request carrying the upgrade. */
const nodeConnect = /** @type {Connect} */ (
	(options, hooks) => {
		const transport = options.protocol === "https:" ? https : http;
		const upstream = transport.request({
			protocol: options.protocol,
			hostname: options.hostname,
			port: options.port,
			path: options.path,
			method: "GET",
			headers: options.headers,
		});
		upstream.on("upgrade", (response, socket, head) => {
			hooks.onUpgrade(response.statusCode ?? 101, response.headers, socket, head);
		});
		upstream.on("response", (response) => {
			hooks.onResponse(response.statusCode ?? 502, response.statusMessage ?? "", response.headers);
			response.resume(); // Drain, or the socket is never released.
		});
		upstream.on("error", (error) => hooks.onError(error.message));
		upstream.end();
		return { abort: () => upstream.destroy() };
	}
);

/**
 * Build the `upgrade` listener for the built server.
 *
 * @param {{ connect?: Connect }} [options]
 * @returns {(request: { url?: string, headers: Headers }, socket: ProxySocket, head: Uint8Array | null) => void}
 */
export function createUpgradeProxy(options = {}) {
	const connect = options.connect ?? nodeConnect;

	return function onUpgrade(request, socket, head) {
		const decision = decideUpgrade(request.url, request.headers);
		if (decision.kind === "reject") {
			socket.destroy();
			return;
		}

		tune(socket);
		// Bytes the client already sent belong to the stream, not to us: push them back
		// so the pipe below carries them upstream in order.
		if (head && head.length > 0) socket.unshift(head);

		let clientGone = false;
		const upstream = connect(upstreamOptions(decision.path, upstreamHeaders(request.headers, socket)), {
			onUpgrade(status, headers, upstreamSocket, upstreamHead) {
				if (clientGone) {
					upstreamSocket.destroy();
					return;
				}
				if (upstreamHead && upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead);
				tune(upstreamSocket);
				socket.write(rawHead(`HTTP/1.1 ${status} Switching Protocols`, headers));
				// A pane that hangs forever is worse than one that says it lost the relay,
				// so either end closing takes the other down.
				upstreamSocket.on("error", () => socket.destroy());
				upstreamSocket.on("close", () => socket.end());
				upstreamSocket.pipe(socket);
				socket.pipe(upstreamSocket);
			},
			onResponse(status, statusMessage, headers) {
				// The API refused the handshake (401/403/503). Relaying ITS answer is what
				// turns "the socket vanished" into a diagnosable failure in the browser.
				socket.write(rawHead(`HTTP/1.1 ${status} ${statusMessage}`.trim(), { ...headers, connection: "close" }));
				socket.end();
			},
			onError() {
				socket.write(rawHead("HTTP/1.1 502 Bad Gateway", { connection: "close" }));
				socket.end();
			},
		});

		socket.on("error", () => upstream.abort());
		socket.on("close", () => {
			clientGone = true;
			upstream.abort();
		});
	};
}

/** The listener the built server mounts. */
export const proxyTerminalUpgrade = createUpgradeProxy();
