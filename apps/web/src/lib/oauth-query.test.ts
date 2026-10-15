import { describe, expect, it } from "vitest";
import { signedOAuthQuery } from "./oauth-query";

describe("signed OAuth query", () => {
  it("keeps only the signed parameters", () => {
    const search = "?client_id=c1&scope=openid&exp=9&ba_param=client_id&ba_param=exp&ba_param=scope&sig=abc&extra=1";
    const query = new URLSearchParams(signedOAuthQuery(search));
    expect(query.get("client_id")).toBe("c1");
    expect(query.get("sig")).toBe("abc");
    expect(query.getAll("ba_param")).toEqual(["client_id", "exp", "scope"]);
    expect(query.has("extra")).toBe(false);
  });

  it("forwards the whole query when the server lists no signed names", () => {
    expect(signedOAuthQuery("?client_id=c1&sig=abc")).toBe("client_id=c1&sig=abc");
  });

  it("returns nothing without a signature", () => {
    expect(signedOAuthQuery("?client_id=c1")).toBeUndefined();
  });
});
