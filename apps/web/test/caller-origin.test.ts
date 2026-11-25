/**
 * The caller origin reaches the API without the request being copied.
 *
 * Copying a proxied request (`new Request(request, { headers })`) made Bun tee its body, and
 * the unread branch stayed reachable with the whole body in it: every file transfer chunk
 * leaked, and a 1 GB upload grew the web process past its memory limit until the kernel killed
 * it. The leak itself only shows in Bun's heap; what this guards is the mechanism — the same
 * request object goes on, with its body untouched.
 */
import { describe, expect, it, vi } from "vitest";
import { CALLER_ORIGIN_HEADER, withCallerOrigin } from "$lib/server/caller-origin";

const CHUNK_URL = "https://pdmux.example/api/hosts/h1/file-transfers/t1/entries/e1/chunk";

describe("[TC-PDFILE-022] a proxied body is not copied to add the caller origin", () => {
  it("sets the header on the same request, replacing the caller's value, and leaves the body unread", async () => {
    const request = new Request(CHUNK_URL, {
      method: "PUT",
      body: new Uint8Array(1024).fill(7),
      headers: { [CALLER_ORIGIN_HEADER]: "https://elsewhere.example", "content-type": "application/octet-stream" },
    });
    const result = withCallerOrigin(request);
    expect(result).toBe(request);
    expect(result.headers.get(CALLER_ORIGIN_HEADER)).toBe("https://pdmux.example");
    expect(result.headers.get("content-type")).toBe("application/octet-stream");
    expect(result.bodyUsed).toBe(false);
    const body = new Uint8Array(await result.arrayBuffer());
    expect(body.byteLength).toBe(1024);
    expect(body.every((byte) => byte === 7)).toBe(true);
  });

  it("falls back to a copy, still with the header, where request headers cannot be changed", () => {
    const request = new Request(CHUNK_URL, { method: "PUT", body: "x", headers: { [CALLER_ORIGIN_HEADER]: "https://elsewhere.example" } });
    vi.spyOn(request.headers, "set").mockImplementationOnce(() => {
      throw new TypeError("immutable");
    });
    const result = withCallerOrigin(request);
    expect(result).not.toBe(request);
    expect(result.method).toBe("PUT");
    expect(result.headers.get(CALLER_ORIGIN_HEADER)).toBe("https://pdmux.example");
  });
});
