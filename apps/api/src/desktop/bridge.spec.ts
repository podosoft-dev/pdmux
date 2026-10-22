import { describe, expect, it } from "bun:test";
import { DesktopBridge, safeHeaders } from "./bridge";
import { hostRoute } from "./host-route";

function pair(handler: ConstructorParameters<typeof DesktopBridge>[1]): [DesktopBridge, DesktopBridge] {
  const left = new DesktopBridge(data => queueMicrotask(() => right.receive(data)), async () => new Response(null, { status: 403 }));
  const right = new DesktopBridge(data => queueMicrotask(() => left.receive(data)), handler);
  return [left, right];
}
const request = { hostKey: "host:test", method: "POST" as const, path: "/hosts/00000000-0000-4000-8000-000000000001/files/upload", headers: {} };

describe("[TC-PDDESKTOP-013] bounded desktop relay", () => {
  it("[TC-PDTERM-144] keeps inline image safety headers without stale compressed lengths", () => {
    const headers = new Headers({ "content-type": "image/png", "content-disposition": "inline; filename=preview.png",
      "content-encoding": "gzip", "content-length": "123", "x-content-type-options": "nosniff", "set-cookie": "private=value" });
    expect(safeHeaders(headers)).toEqual({ "content-type": "image/png", "content-disposition": "inline; filename=preview.png", "x-content-type-options": "nosniff" });
  });
  it("keeps uncompressed download lengths and byte-range metadata", () => {
    const headers = { "content-type": "image/png", "content-length": "100", "content-range": "bytes 100-199/200", "accept-ranges": "bytes" };
    expect(safeHeaders(new Headers(headers))).toEqual(headers);
  });
  it("streams a body larger than the flow-control window in both directions", async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(73);
    const [left, right] = pair(async (_request, body) => new Response(body, { headers: { "content-type": "application/octet-stream" } }));
    try {
      const response = await left.request(request, new Blob([bytes]).stream());
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally { left.close(); right.close(); }
  });
  it("preserves bodyless successful responses", async () => {
    const [left, right] = pair(async () => new Response(null, { status: 204 }));
    try { expect((await left.request({ ...request, method: "GET" })).status).toBe(204); }
    finally { left.close(); right.close(); }
  });
  it("cancels an in-flight operation when the caller aborts", async () => {
    let aborted = false;
    const [left, right] = pair(async (_request, _body, signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<Response>(() => undefined);
    });
    const controller = new AbortController();
    const pending = left.request(request, null, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 5)); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "DESKTOP_DISCONNECTED" });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(aborted).toBe(true); left.close(); right.close();
  });
  it("refuses credentials, path escapes, and arbitrary destinations", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(hostRoute("POST", `/hosts/${id}/tokens`)).toBeNull();
    expect(hostRoute("GET", `https://outside/hosts/${id}`)).toBeNull();
    expect(hostRoute("GET", `/hosts/${id}/files%2fdownload`)).toBeNull();
    expect(hostRoute("GET", `/hosts/${id}/metrics?from=1`)?.rewrite("replacement")).toBe("/hosts/replacement/metrics?from=1");
  });
});
