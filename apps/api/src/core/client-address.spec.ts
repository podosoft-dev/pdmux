import { describe, expect, it } from "bun:test";
import { validateEnv } from "../config/env.validation";
import {
  CLIENT_ADDRESS_HEADER,
  clientAddressOf,
  resolveClientAddress,
  stampClientAddress,
} from "./client-address";

const forwarded = (value: string): Headers => new Headers({ "x-forwarded-for": value });
const config = (trustedProxyHops: number) => ({ trustedProxyHops, header: "x-forwarded-for" });

describe("resolveClientAddress", () => {
  it("uses the socket peer and ignores a caller's header without trusted proxies", () => {
    expect(resolveClientAddress(forwarded("198.51.100.66"), "10.0.0.9", config(0))).toBe("10.0.0.9");
    expect(resolveClientAddress(forwarded("198.51.100.66"), "::ffff:10.0.0.9", config(0))).toBe("10.0.0.9");
    expect(resolveClientAddress(new Headers(), undefined, config(0))).toBeUndefined();
  });

  it("takes the entry the trusted proxies appended, never one further left", () => {
    // A caller sent "198.51.100.66"; the one trusted proxy appended the real client.
    const chain = forwarded("198.51.100.66, 203.0.113.7");
    expect(resolveClientAddress(chain, "10.0.0.9", config(1))).toBe("203.0.113.7");
    expect(resolveClientAddress(chain, "10.0.0.9", config(2))).toBe("198.51.100.66");
    expect(resolveClientAddress(forwarded("203.0.113.7"), "10.0.0.9", config(1))).toBe("203.0.113.7");
    expect(
      resolveClientAddress(new Headers({ "x-real-ip": "203.0.113.8" }), "10.0.0.9", {
        trustedProxyHops: 1,
        header: "x-real-ip",
      }),
    ).toBe("203.0.113.8");
  });

  it("falls back to the peer for a short or malformed chain", () => {
    expect(resolveClientAddress(new Headers(), "10.0.0.9", config(1))).toBe("10.0.0.9");
    expect(resolveClientAddress(forwarded("203.0.113.7"), "10.0.0.9", config(2))).toBe("10.0.0.9");
    expect(resolveClientAddress(forwarded("attacker-controlled"), "10.0.0.9", config(1))).toBe("10.0.0.9");
    expect(resolveClientAddress(forwarded("203.0.113.7, not-an-ip"), "10.0.0.9", config(1))).toBe("10.0.0.9");
  });

  it("reads the address the API set", () => {
    expect(clientAddressOf(new Headers({ [CLIENT_ADDRESS_HEADER]: "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientAddressOf(new Headers())).toBeUndefined();
    expect(clientAddressOf(undefined)).toBeUndefined();
  });
});

describe("client address settings", () => {
  it("validates the trusted proxy settings and refuses the rate limiter's former names", () => {
    expect(validateEnv({})).toMatchObject({ TRUSTED_PROXY_HOPS: 0, TRUSTED_PROXY_HEADER: "x-forwarded-for" });
    expect(validateEnv({ TRUSTED_PROXY_HOPS: "1", TRUSTED_PROXY_HEADER: "X-Real-IP" }))
      .toMatchObject({ TRUSTED_PROXY_HOPS: 1, TRUSTED_PROXY_HEADER: "x-real-ip" });
    expect(() => validateEnv({ TRUSTED_PROXY_HOPS: "-1" })).toThrow("TRUSTED_PROXY_HOPS");
    expect(() => validateEnv({ TRUSTED_PROXY_HEADER: "bad header" })).toThrow("TRUSTED_PROXY_HEADER");
    expect(() => validateEnv({ RATE_LIMIT_TRUSTED_PROXY_HOPS: "1" }))
      .toThrow("RATE_LIMIT_TRUSTED_PROXY_HOPS was renamed to TRUSTED_PROXY_HOPS");
    expect(() => validateEnv({ RATE_LIMIT_PROXY_HEADER: "x-forwarded-for" }))
      .toThrow("RATE_LIMIT_PROXY_HEADER was renamed to TRUSTED_PROXY_HEADER");
  });
});

describe("stampClientAddress", () => {
  const request = (headers: Record<string, string>): Request => new Request("http://localhost/x", { headers });

  it("replaces a caller's own address header and ignores its forwarded header without trusted proxies", () => {
    const spoofed = request({ "x-forwarded-for": "198.51.100.66", [CLIENT_ADDRESS_HEADER]: "198.51.100.67" });
    expect(stampClientAddress(spoofed, "::ffff:127.0.0.1", config(0))).toBe("127.0.0.1");
    expect(clientAddressOf(spoofed.headers)).toBe("127.0.0.1");
  });

  it("records the rightmost forwarded entry behind one trusted proxy", () => {
    const proxied = request({ "x-forwarded-for": "198.51.100.66, 203.0.113.7" });
    expect(stampClientAddress(proxied, "10.0.0.9", config(1))).toBe("203.0.113.7");
    expect(clientAddressOf(proxied.headers)).toBe("203.0.113.7");
  });

  it("removes a caller's value when no address can be resolved", () => {
    const unknown = request({ [CLIENT_ADDRESS_HEADER]: "198.51.100.67" });
    expect(stampClientAddress(unknown, undefined, config(0))).toBeUndefined();
    expect(clientAddressOf(unknown.headers)).toBeUndefined();
  });
});
