import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyRequest } from "../src/lib/server/backend-proxy";

/**
 * ⚠ THIS FILE IS IN `test/`, NOT BESIDE THE MODULE, BECAUSE THAT IS WHERE THE
 * SUITE LOOKS. `vitest.config.ts` includes only the `test/` directory — a spec
 * written next to its source is collected by no one and passes forever. There is
 * such a file already: `src/lib/server/backend-proxy.test.ts`.
 */

describe("[TC-PDWEB-030] the proxy carries a file download end to end", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const roundTrip = async (requestHeaders: Record<string, string>, upstreamHeaders: Record<string, string>) => {
    let seen: Headers | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response("bytes", { status: 206, headers: upstreamHeaders });
    });
    const request = new Request("http://app.localhost/api/hosts/h/files/download?path=a.bin", {
      headers: requestHeaders,
    });
    const response = await proxyRequest(request, "http://api:5002/hosts/h/files/download?path=a.bin");
    return { sent: seen, response };
  };

  it("passes Range up so a dropped download resumes instead of restarting", async () => {
    // ⚠ DROPPED HERE, THE FAILURE IS SILENT AND EXPENSIVE: the API answers 200
    // from byte zero, the browser starts the file again, and the only symptom is
    // that a big download never finishes.
    const { sent } = await roundTrip({ range: "bytes=1024-" }, {});
    expect(sent?.get("range")).toBe("bytes=1024-");
  });

  it("relays the headers that make it a file rather than a page", async () => {
    const { response } = await roundTrip(
      {},
      {
        "content-type": "image/png",
        "content-disposition": "attachment; filename*=UTF-8''shot.png",
        "content-length": "5",
        "content-range": "bytes 0-4/5",
        "accept-ranges": "bytes",
        "x-content-type-options": "nosniff",
      },
    );
    // Without disposition the browser names the file after the route; without
    // length it can show no progress; without the range pair it cannot resume.
    expect(response.headers.get("content-disposition")).toContain("shot.png");
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("content-range")).toBe("bytes 0-4/5");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.status).toBe(206);
  });
});
