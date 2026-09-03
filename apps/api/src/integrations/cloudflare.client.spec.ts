import { describe, expect, it } from "bun:test";
import { CloudflareClient } from "./cloudflare.client";

function rows(count: number, kind: "zone" | "policy"): unknown[] {
  return Array.from({ length: count }, (_, index) => kind === "zone"
    ? { id: `zone-${index}`, name: `zone-${index}.example.com`, account: { id: "account-1", name: "Example" } }
    : { id: `policy-${index}`, name: `Policy ${index}` });
}

describe("CloudflareClient", () => {
  it("[TC-PDEXTERNAL-011] discovers every zone and reusable policy across paginated responses", async () => {
    const requests: string[] = [];
    const requestFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      requests.push(`${url.pathname}${url.search}`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      const page = Number(url.searchParams.get("page"));
      const kind = url.pathname === "/client/v4/zones" ? "zone" : "policy";
      const result = page === 1 ? rows(50, kind) : rows(1, kind);
      return Response.json({ success: true, result, result_info: { page, total_pages: 2 } });
    };
    const client = new CloudflareClient("test-token", requestFetch as typeof fetch);

    expect(await client.zones()).toHaveLength(51);
    expect(await client.policies("account-1")).toHaveLength(51);
    expect(requests).toEqual([
      "/client/v4/zones?status=active&per_page=50&page=1",
      "/client/v4/zones?status=active&per_page=50&page=2",
      "/client/v4/accounts/account-1/access/policies?per_page=50&page=1",
      "/client/v4/accounts/account-1/access/policies?per_page=50&page=2",
    ]);
  });
});
