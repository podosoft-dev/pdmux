import { describe, expect, it, mock } from "bun:test";
import { FS_CHUNK_BYTES } from "@pdmux/protocol";
import { AppException } from "@podosoft/podokit-contracts";
import { Elysia } from "elysia";
import type { AuthSession } from "../auth/auth.service";
import type { AppContext } from "../core/services";
import { ServiceRegistry } from "../core/services";
import { pdmuxHttpPlugin } from "./pdmux.http";
import { PDMUX, type PdmuxServices } from "./pdmux.services";

const session: AuthSession = {
  user: { id: "user-1", role: "admin", name: "User", email: "user@example.com" },
  session: {},
};

interface TestApplication {
  handle(request: Request): Response | Promise<Response>;
}

function application(overrides: Partial<PdmuxServices>): TestApplication {
  const pdmux = {
    auth: {
      requireSession: mock(async () => session),
      requireAdmin: mock(async () => session),
      session: mock(async () => session),
    },
    audit: { recordRequest: mock(async () => undefined) },
    ...overrides,
  } as unknown as PdmuxServices;
  const services = new ServiceRegistry();
  services.register(PDMUX, pdmux);
  return new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof AppException) {
        set.status = error.statusCode;
        return { error: { code: error.code } };
      }
      return undefined;
    })
    .use(pdmuxHttpPlugin({ services } as AppContext));
}

describe("PDMUX HTTP boundary", () => {
  it("resolves the authenticated personal scope for host lists", async () => {
    const list = mock(async (scopeId: string) => [{ id: "host-1", scopeId }]);
    const response = await application({
      hosts: { list } as unknown as PdmuxServices["hosts"],
    }).handle(new Request("http://localhost/hosts"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "host-1", scopeId: "personal:user-1" }]);
    expect(list).toHaveBeenCalledWith("personal:user-1");
  });

  it("redeems a public enrollment with the forwarded client address", async () => {
    const redeem = mock(async (code: string, ip: string | null) => ({ code, ip }));
    const response = await application({
      agentEnrollments: { redeem } as unknown as PdmuxServices["agentEnrollments"],
    }).handle(new Request("http://localhost/agent/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7, 10.0.0.2" },
      body: JSON.stringify({ code: " enroll-code " }),
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ code: "enroll-code", ip: "203.0.113.7" });
  });

  it("[TC-PDTERM-143] streams a ranged file response with resumable download headers", async () => {
    const chunk = mock(async (_scope: string, _host: string, _path: string, offset: number) => ({
      data: Buffer.from(offset === 1 ? "bc" : "abc").toString("base64"),
      size: 3,
      eof: true,
      error: null,
    }));
    const response = await application({
      agentFiles: { chunk } as unknown as PdmuxServices["agentFiles"],
    }).handle(new Request("http://localhost/hosts/host-1/files/download?path=log.txt", {
      headers: { range: "bytes=1-" },
    }));

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-2/3");
    expect(response.headers.get("content-length")).toBe("2");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("bc");
    expect(chunk.mock.calls[0]?.[3]).toBe(1);
  });

  it("[TC-PDTERM-144] restricts inline content and prevents MIME sniffing", async () => {
    const chunk = mock(async () => ({
      data: Buffer.from("<svg/>").toString("base64"),
      size: 6,
      eof: true,
      error: null,
    }));
    const unsafe = await application({
      agentFiles: { chunk } as unknown as PdmuxServices["agentFiles"],
    }).handle(new Request("http://localhost/hosts/host-1/files/download?path=vector.svg&inline=1"));
    expect(unsafe.headers.get("content-disposition")?.startsWith("attachment;")).toBe(true);
    expect(unsafe.headers.get("x-content-type-options")).toBe("nosniff");

    const safe = await application({
      agentFiles: { chunk } as unknown as PdmuxServices["agentFiles"],
    }).handle(new Request("http://localhost/hosts/host-1/files/download?path=pixel.png&inline=1"));
    expect(safe.headers.get("content-disposition")?.startsWith("inline;")).toBe(true);
  });

  it("[TC-PDTERM-147] uploads request bodies to the agent in bounded chunks", async () => {
    const put = mock(async (
      _scope: string,
      _host: string,
      path: string,
      offset: number,
      data: Uint8Array,
      create: boolean,
    ) => ({ path, offset, bytes: data.byteLength, create, error: null }));
    const body = new Uint8Array(FS_CHUNK_BYTES + 3).fill(97);
    const response = await application({
      agentFiles: { put } as unknown as PdmuxServices["agentFiles"],
    }).handle(new Request("http://localhost/hosts/host-1/files/upload?path=data.bin", {
      method: "POST",
      body,
    }));

    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]?.slice(0, 4)).toEqual(["personal:user-1", "host-1", "data.bin", 0]);
    expect(put.mock.calls[0]?.[4].byteLength).toBe(FS_CHUNK_BYTES);
    expect(put.mock.calls[0]?.[5]).toBe(true);
    expect(put.mock.calls[1]?.[3]).toBe(FS_CHUNK_BYTES);
    expect(put.mock.calls[1]?.[4].byteLength).toBe(3);
    expect(put.mock.calls[1]?.[5]).toBe(false);
  });

  it("[TC-PDTERM-148] forwards file deletion intent and rejects an empty path", async () => {
    const remove = mock(async (_scope: string, _host: string, path: string, recursive: boolean) => ({
      path,
      recursive,
      removed: 1,
      error: null,
    }));
    const audit = mock(async () => undefined);
    const app = application({
      agentFiles: { remove } as unknown as PdmuxServices["agentFiles"],
      audit: { recordRequest: audit } as unknown as PdmuxServices["audit"],
    });
    const response = await app.handle(new Request(
      "http://localhost/hosts/host-1/files?path=cache%2Fitem&recursive=1",
      { method: "DELETE" },
    ));
    expect(response.status).toBe(200);
    expect(remove).toHaveBeenCalledWith("personal:user-1", "host-1", "cache/item", true);
    expect(audit).toHaveBeenCalledWith(
      "host.files.delete",
      expect.any(Request),
      session,
      expect.objectContaining({ label: "cache/item", metadata: { recursive: true } }),
    );

    const empty = await app.handle(new Request("http://localhost/hosts/host-1/files", { method: "DELETE" }));
    expect(empty.status).toBe(400);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("passes the complete Web Standard request to the MCP transport", async () => {
    const handle = mock(async (request: Request) => Response.json({ method: request.method }, {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    }));
    const response = await application({
      mcp: { handle } as unknown as PdmuxServices["mcp"],
    }).handle(new Request("http://localhost/mcp", { method: "DELETE" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ method: "DELETE" });
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
