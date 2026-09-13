import { describe, expect, it } from "bun:test";
import { createServer, request, type Server } from "node:http";
import { startDesktopGateway } from "./gateway.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

describe("[TC-PDDESKTOP-005] loopback desktop gateway", () => {
  it("preserves binary HTTP bodies, replaces forwarded authority and rejects foreign Host", async () => {
    const web = createServer((request, response) => {
      response.setHeader("x-observed-host", request.headers["x-forwarded-host"] ?? "");
      response.setHeader("x-observed-proto", request.headers["x-forwarded-proto"] ?? "");
      request.pipe(response);
    });
    const url = await listen(web);
    const gateway = await startDesktopGateway(url, url, 0);
    try {
      const payload = new Uint8Array([0, 255, 13, 10, 128]);
      const response = await fetch(`${gateway.url}/api/upload`, { method: "POST", body: payload, headers: { "x-forwarded-host": "example.com", "x-forwarded-proto": "https" } });
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
      expect(response.headers.get("x-observed-host")).toBe(new URL(gateway.url).host);
      expect(response.headers.get("x-observed-proto")).toBe("http");
      expect((await fetch(gateway.url, { headers: { host: "example.com" } })).status).toBe(400);
      const status = await new Promise<number | undefined>((accept, reject) => {
        const invalid = request(gateway.url, { path: "/\\example.com/" }, response => {
          response.resume();
          accept(response.statusCode);
        });
        invalid.once("error", reject);
        invalid.end();
      });
      expect(status).toBe(400);
    } finally { await gateway.close(); web.closeAllConnections(); await new Promise<void>(accept => web.close(() => accept())); }
  });
});
