import { Duplex } from "node:stream";
import { AGENT_WS_PATH, TERMINAL_WS_PATH } from "@pdmux/protocol";
import { describe, expect, it } from "vitest";
import {
  createUpgradeProxy,
  decideUpgrade,
  upstreamHeaders,
} from "../src/lib/server/terminal-upgrade.js";
import type { Connect, Headers, UpstreamHooks } from "../src/lib/server/terminal-upgrade.js";

/**
 * The built server's upgrade proxy.
 *
 * WHY THIS IS UNIT-TESTED AT ALL: the feature it carries was invisible for a while.
 * Development proxied `/terminal/ws` in Vite, so terminals worked there and were dead
 * on every built deployment — the adapter answered the upgrade with a 303 and each
 * pane sat on "reconnecting" forever. The two decisions worth freezing are therefore
 * *which* upgrades get forwarded (exactly two paths, or this is a tunnel into the API)
 * and *what the browser is told* when the handshake does not complete.
 *
 * The sockets are real duplex streams with the two directions kept apart, so piping,
 * `end()` and `destroy()` behave as they do in production and the test can read the
 * bytes that actually flow. (A `PassThrough` will not do: it loops writes back into
 * its own readable side, so two of them piped together feed each other forever.)
 */

class FakeSocket extends Duplex {
  /** Bytes this side wrote toward its peer. */
  readonly sent: Buffer[] = [];
  remoteAddress?: string;
  encrypted?: boolean;

  constructor(extras: { remoteAddress?: string; encrypted?: boolean } = {}) {
    super();
    this.remoteAddress = extras.remoteAddress;
    this.encrypted = extras.encrypted;
  }

  /** What the peer sent us. */
  receive(data: string): void {
    this.push(Buffer.from(data));
  }

  get written(): string {
    return Buffer.concat(this.sent).toString();
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.sent.push(Buffer.from(chunk));
    done();
  }

  override _read(): void {
    // Pushed by `receive()`; nothing to pull.
  }
}

function socket(extras: { remoteAddress?: string; encrypted?: boolean } = {}): FakeSocket {
  return new FakeSocket(extras);
}

/** Everything the proxy asked the transport to do, without a network. */
function recordingConnect() {
  const calls: { path: string; headers: Headers }[] = [];
  let hooks: UpstreamHooks | null = null;
  let aborted = 0;
  const connect: Connect = (options, given) => {
    calls.push({ path: options.path, headers: options.headers });
    hooks = given;
    return {
      abort: () => {
        aborted += 1;
      },
    };
  };
  return {
    connect,
    calls,
    get hooks() {
      if (!hooks) throw new Error("connect was never called");
      return hooks;
    },
    get aborted() {
      return aborted;
    },
  };
}

const WS_HEADERS = { upgrade: "websocket", connection: "Upgrade", host: "pdmux.example" };

describe("[TC-PDTERM-107] terminal upgrade routing", () => {
  it("[TC-PDTERM-107] forwards the terminal path, with its query, normalized", () => {
    const decision = decideUpgrade(`${TERMINAL_WS_PATH}?hostId=abc`, WS_HEADERS);
    expect(decision).toEqual({ kind: "proxy", path: `${TERMINAL_WS_PATH}?hostId=abc` });
  });

  it("[TC-PDTERM-107] forwards the agent path, with its query, normalized", () => {
    // An agent is pointed at the public origin — the one URL an operator has — so the
    // web server has to relay this upgrade or `pdmux-agent doctor` reports no
    // connectivity and nothing can enrol.
    const decision = decideUpgrade(`${AGENT_WS_PATH}?v=1`, WS_HEADERS);
    expect(decision).toEqual({ kind: "proxy", path: `${AGENT_WS_PATH}?v=1` });
    expect(decideUpgrade(AGENT_WS_PATH, WS_HEADERS)).toEqual({ kind: "proxy", path: AGENT_WS_PATH });
    // The query is load-bearing, not decoration: `?mode=verify` is how a candidate
    // binary asks for a NON-REGISTERING dial during a remote update. Dropping it
    // here would make the candidate's connection evict the live agent and kill
    // every PTY on that host — the outage verify-then-commit exists to avoid.
    expect(decideUpgrade(`${AGENT_WS_PATH}?mode=verify`, WS_HEADERS)).toEqual({
      kind: "proxy",
      path: `${AGENT_WS_PATH}?mode=verify`,
    });
  });

  it("[TC-PDTERM-107] refuses every other path, method and target shape", () => {
    // Forwarding anything but the two relay paths would expose the API's whole private
    // surface to an unauthenticated upgrade from the public origin. The neighbours of a
    // listed path are the cases that prove the match is whole, not a prefix.
    for (const url of [
      "/api/hosts",
      "/",
      `${TERMINAL_WS_PATH}/`,
      `${TERMINAL_WS_PATH}x`,
      `${AGENT_WS_PATH}/`,
      `${AGENT_WS_PATH}x`,
      "/agent",
      "/agent/ws/../../api/hosts",
      "/foo",
      "/terminal/ws/../api/hosts",
      "//evil.example/terminal/ws",
      "http://evil.example/terminal/ws",
      "//evil.example/agent/ws",
      "http://evil.example/agent/ws",
      undefined,
    ]) {
      expect(decideUpgrade(url, WS_HEADERS), `url=${String(url)}`).toMatchObject({ kind: "reject" });
    }
    // `..` must not resolve INTO the relay path either — that target is refused as a
    // shape, so a rewrite can never smuggle one path in as another.
    expect(decideUpgrade("/api/../terminal/ws", WS_HEADERS)).toMatchObject({ kind: "proxy", path: TERMINAL_WS_PATH });
    expect(decideUpgrade("/api/../agent/ws", WS_HEADERS)).toMatchObject({ kind: "proxy", path: AGENT_WS_PATH });
  });

  it("[TC-PDTERM-107] refuses an upgrade that is not a websocket", () => {
    expect(decideUpgrade(TERMINAL_WS_PATH, { ...WS_HEADERS, upgrade: "h2c" })).toMatchObject({ kind: "reject" });
    expect(decideUpgrade(TERMINAL_WS_PATH, { host: "pdmux.example" })).toMatchObject({ kind: "reject" });
  });

  it("[TC-PDTERM-107] destroys a refused upgrade instead of contacting the API", () => {
    const transport = recordingConnect();
    const proxy = createUpgradeProxy({ connect: transport.connect });
    const client = socket();

    proxy({ url: "/api/hosts", headers: WS_HEADERS }, client, null);

    expect(transport.calls).toHaveLength(0);
    expect(client.destroyed).toBe(true);
  });

  it("[TC-PDTERM-107] carries both relay paths upstream and destroys a neighbour of one", () => {
    for (const url of [TERMINAL_WS_PATH, AGENT_WS_PATH]) {
      const transport = recordingConnect();
      const proxy = createUpgradeProxy({ connect: transport.connect });
      const client = socket();

      proxy({ url, headers: WS_HEADERS }, client, null);

      expect(transport.calls[0]?.path, `url=${url}`).toBe(url);
      expect(client.destroyed, `url=${url}`).toBe(false);
    }

    // One character past a listed path is a different path: the allowlist is matched
    // whole, so widening it to the agent never turned it into a prefix rule.
    const transport = recordingConnect();
    const proxy = createUpgradeProxy({ connect: transport.connect });
    const client = socket();

    proxy({ url: `${AGENT_WS_PATH}x`, headers: WS_HEADERS }, client, null);

    expect(transport.calls).toHaveLength(0);
    expect(client.destroyed).toBe(true);
  });
});

describe("[TC-PDTERM-108] terminal upgrade forwarding", () => {
  it("[TC-PDTERM-108] passes the handshake and the session cookie through untouched", () => {
    const transport = recordingConnect();
    const proxy = createUpgradeProxy({ connect: transport.connect });
    const headers = {
      ...WS_HEADERS,
      cookie: "better-auth.session_token=abc123",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      origin: "https://pdmux.example",
    };

    proxy({ url: `${TERMINAL_WS_PATH}?hostId=h1`, headers }, socket({ remoteAddress: "203.0.113.7" }), null);

    const [call] = transport.calls;
    expect(call?.path).toBe(`${TERMINAL_WS_PATH}?hostId=h1`);
    // The API authorises the socket from this cookie at upgrade time; dropping it
    // turns every terminal into a 401.
    expect(call?.headers.cookie).toBe("better-auth.session_token=abc123");
    expect(call?.headers["sec-websocket-key"]).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(call?.headers.upgrade).toBe("websocket");
    expect(call?.headers.origin).toBe("https://pdmux.example");
  });

  it("[TC-PDTERM-108] appends to the forwarded chain rather than replacing it", () => {
    const headers = upstreamHeaders(
      { ...WS_HEADERS, "x-forwarded-for": "198.51.100.1", "x-forwarded-proto": "https" },
      socket({ remoteAddress: "::ffff:10.0.0.9" }),
    );
    // We are one hop: the edge proxy's client comes first, ours last. Overwriting it
    // would report the wrong address to the API.
    expect(headers["x-forwarded-for"]).toBe("198.51.100.1, 10.0.0.9");
    // An edge that already told us the scheme knows better than this hop does.
    expect(headers["x-forwarded-proto"]).toBe("https");
    expect(headers["x-forwarded-host"]).toBe("pdmux.example");
  });

  it("[TC-PDTERM-108] reports its own hop when there is no chain", () => {
    const plain = upstreamHeaders(WS_HEADERS, socket({ remoteAddress: "::1" }));
    expect(plain["x-forwarded-for"]).toBe("127.0.0.1");
    expect(plain["x-forwarded-proto"]).toBe("http");

    const tls = upstreamHeaders(WS_HEADERS, socket({ remoteAddress: "203.0.113.7", encrypted: true }));
    expect(tls["x-forwarded-proto"]).toBe("https");
  });
});

describe("[TC-PDTERM-109] terminal upgrade completion", () => {
  it("[TC-PDTERM-109] relays the 101 and pipes both directions", async () => {
    const transport = recordingConnect();
    const proxy = createUpgradeProxy({ connect: transport.connect });
    const client = socket({ remoteAddress: "203.0.113.7" });

    proxy({ url: TERMINAL_WS_PATH, headers: WS_HEADERS }, client, Buffer.from("early-frame"));
    const upstream = socket();
    transport.hooks.onUpgrade(101, { upgrade: "websocket", connection: "Upgrade" }, upstream, null);

    expect(client.written).toContain("HTTP/1.1 101 Switching Protocols");
    expect(client.written).toContain("upgrade: websocket");

    upstream.receive("from-agent");
    client.receive("from-browser");
    await new Promise((resolve) => setImmediate(resolve));
    // Bytes the client had already sent when the handshake completed belong to the
    // stream, so they must arrive upstream in order rather than being dropped.
    expect(upstream.written).toBe("early-framefrom-browser");
    expect(client.written).toContain("from-agent");
  });

  it("[TC-PDTERM-109] relays the API's refusal so the browser can report it", () => {
    const transport = recordingConnect();
    const proxy = createUpgradeProxy({ connect: transport.connect });
    const client = socket();

    proxy({ url: `${TERMINAL_WS_PATH}?hostId=h1`, headers: WS_HEADERS }, client, null);
    transport.hooks.onResponse(401, "Unauthorized", { "content-type": "application/json" });

    expect(client.written).toContain("HTTP/1.1 401 Unauthorized");
    expect(client.written).toContain("connection: close");
    expect(client.writableEnded).toBe(true);
  });

  it("[TC-PDTERM-109] closes the client when the API is unreachable", () => {
    const transport = recordingConnect();
    const proxy = createUpgradeProxy({ connect: transport.connect });
    const client = socket();

    proxy({ url: TERMINAL_WS_PATH, headers: WS_HEADERS }, client, null);
    transport.hooks.onError("ECONNREFUSED");

    // A pane that hangs forever is worse than one that says it lost the relay.
    expect(client.written).toContain("HTTP/1.1 502 Bad Gateway");
    expect(client.writableEnded).toBe(true);
  });

  it("[TC-PDTERM-109] ends the client when the upstream socket closes", async () => {
    const transport = recordingConnect();
    const proxy = createUpgradeProxy({ connect: transport.connect });
    const client = socket();

    proxy({ url: TERMINAL_WS_PATH, headers: WS_HEADERS }, client, null);
    const upstream = socket();
    transport.hooks.onUpgrade(101, {}, upstream, null);
    upstream.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    expect(client.writableEnded).toBe(true);
  });

  it("[TC-PDTERM-109] abandons the upstream request when the client goes away", async () => {
    const transport = recordingConnect();
    const proxy = createUpgradeProxy({ connect: transport.connect });
    const client = socket();

    proxy({ url: TERMINAL_WS_PATH, headers: WS_HEADERS }, client, null);
    client.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.aborted).toBeGreaterThan(0);
  });
});
