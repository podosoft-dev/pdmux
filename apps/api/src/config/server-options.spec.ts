import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { validateEnv } from "./env.validation";
import { apiServerOptions, DEFAULT_MAX_REQUEST_BODY_SIZE } from "./server-options";

describe("apiServerOptions", () => {
  it("defaults to Bun's request body limit and leaves the idle timeout to Elysia", () => {
    const env = validateEnv({});
    expect(env.API_MAX_REQUEST_BODY_SIZE).toBe(DEFAULT_MAX_REQUEST_BODY_SIZE);
    expect(apiServerOptions(env, {})).toEqual({ maxRequestBodySize: DEFAULT_MAX_REQUEST_BODY_SIZE });
  });

  it("reads API_MAX_REQUEST_BODY_SIZE and rejects values that are not byte counts", () => {
    expect(apiServerOptions(validateEnv({ API_MAX_REQUEST_BODY_SIZE: "1073741824" }), {}))
      .toEqual({ maxRequestBodySize: 1_073_741_824 });
    for (const value of ["0", "-1", "1.5", "lots"]) {
      expect(() => validateEnv({ API_MAX_REQUEST_BODY_SIZE: value })).toThrow("API_MAX_REQUEST_BODY_SIZE");
    }
  });

  it("lets the application's options win over the environment", () => {
    const env = validateEnv({ API_MAX_REQUEST_BODY_SIZE: "1024" });
    expect(apiServerOptions(env, { maxRequestBodySize: 4096, idleTimeout: 120 }))
      .toEqual({ maxRequestBodySize: 4096, idleTimeout: 120 });
    expect(apiServerOptions(env, (current) => ({ maxRequestBodySize: current.API_MAX_REQUEST_BODY_SIZE * 2 })))
      .toEqual({ maxRequestBodySize: 2048 });
    expect(() => apiServerOptions(env, { maxRequestBodySize: 0 })).toThrow("maxRequestBodySize");
    expect(() => apiServerOptions(env, { idleTimeout: 256 })).toThrow("idleTimeout");
    expect(() => apiServerOptions(env, { idleTimeout: -1 })).toThrow("idleTimeout");
  });

  it("makes the server refuse a body above the limit with 413", async () => {
    const app = new Elysia()
      .post("/upload", async ({ request }) => ({ size: (await request.arrayBuffer()).byteLength }))
      .listen({ ...apiServerOptions(validateEnv({}), { maxRequestBodySize: 1024 }), hostname: "127.0.0.1", port: 0 });
    try {
      const url = `http://127.0.0.1:${app.server?.port}/upload`;
      const accepted = await fetch(url, { method: "POST", body: new Uint8Array(1024) });
      expect(await accepted.json()).toEqual({ size: 1024 });
      const refused = await fetch(url, { method: "POST", body: new Uint8Array(1025) });
      expect(refused.status).toBe(413);
    } finally {
      await app.stop();
    }
  });
});
