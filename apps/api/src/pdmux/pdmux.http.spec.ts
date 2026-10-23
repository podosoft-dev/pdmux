import { describe, expect, it, mock } from "bun:test";
import { FS_CHUNK_BYTES, FILE_TRANSFER_CHUNK_BYTES } from "@pdmux/protocol";
import { AppException } from "@podosoft/podokit-contracts";
import { Elysia } from "elysia";
import type { AuthSession } from "../auth/auth.service";
import { databaseUnavailable } from "../auth/database-outage";
import { CLIENT_ADDRESS_HEADER } from "../core/client-address";
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
    database: { assertReady: (): void => undefined },
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
  it("[TC-PDFILE-017] serves exact closed, open and suffix byte ranges including byte zero", async (): Promise<void> => {
    const bytes = Buffer.from("0123456789");
    const chunk = mock(async (_scope: string, _host: string, _path: string, offset: number, length: number) => ({
      data: bytes.subarray(offset, offset + length).toString("base64"), size: bytes.length,
      eof: offset + length >= bytes.length, error: null,
    }));
    const app = application({ agentFiles: { chunk } as unknown as PdmuxServices["agentFiles"] });
    for (const [range, expected, contentRange] of [["bytes=0-2", "012", "bytes 0-2/10"], ["bytes=3-5", "345", "bytes 3-5/10"], ["bytes=8-", "89", "bytes 8-9/10"], ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=7-99", "789", "bytes 7-9/10"]]) {
      const response = await app.handle(new Request("http://localhost/hosts/host-1/files/download?path=clip.mp4&inline=1", { headers: { range: range ?? "" } }));
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange ?? "");
      expect(response.headers.get("content-length")).toBe(String(expected?.length));
      expect(await response.text()).toBe(expected ?? "");
    }
    const invalid = await app.handle(new Request("http://localhost/hosts/host-1/files/download?path=clip.mp4", { headers: { range: "bytes=99-" } }));
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */10");
  });
  it("[TC-PDFILE-017] stops requesting chunks when a streamed preview is cancelled", async (): Promise<void> => {
    const chunk = mock(async (_scope: string, _host: string, _path: string, offset: number) => ({ data: Buffer.from("ab").toString("base64"), size: 10, offset, eof: false, error: null }));
    const response = await application({ agentFiles: { chunk } as unknown as PdmuxServices["agentFiles"] })
      .handle(new Request("http://localhost/hosts/host-1/files/download?path=clip.webm&inline=1"));
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([97, 98]));
    await reader.cancel();
    expect(chunk).toHaveBeenCalledTimes(1);
    for (const path of ["paper.pdf", "sound.wav", "clip.webm", "icon.ico"]) {
      const preview = await application({ agentFiles: { chunk } as unknown as PdmuxServices["agentFiles"] })
        .handle(new Request(`http://localhost/hosts/host-1/files/download?path=${path}&inline=1`));
      expect(preview.headers.get("content-disposition")).toStartWith("inline;");
      await preview.body?.cancel();
    }
  });
  it("[TC-PDFILE-004] scopes a transfer history removal to the authenticated owner", async (): Promise<void> => {
    const remove = mock(async (): Promise<{ id: string }> => ({ id: "job" }));
    const url = "http://localhost/hosts/host-1/file-transfers/job";
    const response = await application({ fileTransfers: { remove } as unknown as PdmuxServices["fileTransfers"] })
      .handle(new Request(url, { method: "DELETE" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "job" });
    expect(remove).toHaveBeenCalledWith({ userId: "user-1", organizationId: "personal:user-1", hostId: "host-1" }, "job");
  });
  it("[TC-PDFILE-004] keeps transfer requests that wait for the host lock alive beyond the server idle timeout", async (): Promise<void> => {
    // Bun closes a silent connection on a 4-second tick, so with idleTimeout 1 a
    // request that answers after 5 seconds is cut unless its route lifts the timeout.
    const slow = <T>(value: T) => mock(async (): Promise<T> => { await Bun.sleep(5_000); return value; });
    const fileTransfers = {
      commit: slow({ id: "entry" }),
      reconcile: slow({ id: "entry" }),
      decide: slow({ id: "entry" }),
      remove: slow({ id: "job" }),
      get: slow({ id: "job" }),
    };
    const app = application({ fileTransfers: fileTransfers as unknown as PdmuxServices["fileTransfers"] }) as Elysia;
    app.listen({ hostname: "127.0.0.1", port: 0, idleTimeout: 1 });
    const base = `http://127.0.0.1:${app.server?.port}/hosts/host-1/file-transfers/job`;
    const call = (path: string, init: RequestInit): Promise<number | string> =>
      fetch(`${base}${path}`, init).then((response) => response.status, (error: unknown) => String(error));
    try {
      const [commit, reconcile, decision, remove, read] = await Promise.all([
        call("/entries/entry/commit", { method: "POST" }),
        call("/entries/entry/reconcile", { method: "POST" }),
        call("/entries/entry/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "skip" }) }),
        call("", { method: "DELETE" }),
        call("", { method: "GET" }),
      ]);
      expect({ commit, reconcile, decision, remove }).toEqual({ commit: 200, reconcile: 200, decision: 200, remove: 200 });
      // A route that answers from the database keeps the server-wide timeout.
      expect(read).not.toBe(200);
    } finally { await app.stop(true); }
  }, 15_000);
  it("[TC-PDFILE-004] authorizes transfer chunks before reading and enforces the binary cap", async (): Promise<void> => {
    const owner = { userId: "user-1", organizationId: "personal:user-1", hostId: "host-1" };
    const get = mock(async (): Promise<unknown> => ({}));
    const chunk = mock(async (): Promise<unknown> => ({ offset: FILE_TRANSFER_CHUNK_BYTES }));
    const app = application({ fileTransfers: { get, chunk } as unknown as PdmuxServices["fileTransfers"] });
    const url = "http://localhost/hosts/host-1/file-transfers/job/entries/entry/chunk";
    const request = (size: number): Request => new Request(url, {
      method: "PUT", headers: { "content-type": "application/octet-stream", "x-transfer-offset": "1048576", "x-transfer-sha256": "digest" },
      body: new Uint8Array(size).fill(255),
    });
    const response = await app.handle(request(FILE_TRANSFER_CHUNK_BYTES));
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith(owner, "job");
    expect(chunk).toHaveBeenCalledWith(owner, "job", "entry", 1048576, "digest", expect.any(Uint8Array));
    const large = await app.handle(request(FILE_TRANSFER_CHUNK_BYTES + 1));
    expect(large.status).toBe(413);
    expect(chunk).toHaveBeenCalledTimes(1);
    const denied = application({
      auth: { requireSession: async (): Promise<never> => { throw new AppException("UNAUTHORIZED", "Unauthorized", 401); } } as unknown as PdmuxServices["auth"],
      fileTransfers: { get, chunk } as unknown as PdmuxServices["fileTransfers"],
    });
    expect((await denied.handle(request(7))).status).toBe(401);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("[TC-PDFILE-004] validates transfer manifests and scopes creation from the session", async (): Promise<void> => {
    const create = mock(async (_owner: unknown, input: unknown): Promise<unknown> => input);
    const app = application({ fileTransfers: { create } as unknown as PdmuxServices["fileTransfers"] });
    const input = { id: "11111111-1111-4111-8111-111111111111", direction: "upload", basePath: "folder", selection: [] };
    const response = await app.handle(new Request("http://localhost/hosts/host-1/file-transfers", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    }));
    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith({ userId: "user-1", organizationId: "personal:user-1", hostId: "host-1" }, input);
    const malformed = await app.handle(new Request("http://localhost/hosts/host-1/file-transfers/job/manifest", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: [{ kind: "link" }] }),
    }));
    expect(malformed.status).toBe(422);
  });

  it("resolves the authenticated personal scope for host lists", async () => {
    const list = mock(async (scopeId: string) => [{ id: "host-1", scopeId }]);
    const response = await application({
      hosts: { list } as unknown as PdmuxServices["hosts"],
    }).handle(new Request("http://localhost/hosts"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "host-1", scopeId: "personal:user-1" }]);
    expect(list).toHaveBeenCalledWith("personal:user-1");
  });

  it("redeems a public enrollment with the client address the API resolved", async () => {
    const redeem = mock(async (code: string, ip: string | null) => ({ code, ip }));
    const response = await application({
      agentEnrollments: { redeem } as unknown as PdmuxServices["agentEnrollments"],
    }).handle(new Request("http://localhost/agent/enroll", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLIENT_ADDRESS_HEADER]: "203.0.113.7",
        "x-forwarded-for": "198.51.100.66",
      },
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

  it("[TC-PDMCP-061] preserves raw MCP JSON for the transport when the desktop routing hook is installed", async () => {
    const payload = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "boundary-test", version: "1" } } };
    const handle = mock(async (request: Request): Promise<Response> => {
      expect(request.bodyUsed).toBe(false);
      return Response.json(await request.json());
    });
    const response = await application({ mcp: { handle } as unknown as PdmuxServices["mcp"] })
      .handle(new Request("http://localhost/mcp", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("[TC-PDHOST-033] answers 503 before pdmux's database connects and keeps serving the agent kit", async () => {
    const list = mock(async () => []);
    const redeem = mock(async () => ({}));
    const handle = mock(async () => Response.json({}));
    const manifest = mock(async () => Response.json({ version: "kit" }));
    const app = application({
      database: { assertReady: (): void => { throw databaseUnavailable(); } } as unknown as PdmuxServices["database"],
      hosts: { list } as unknown as PdmuxServices["hosts"],
      agentEnrollments: { redeem } as unknown as PdmuxServices["agentEnrollments"],
      mcp: { handle } as unknown as PdmuxServices["mcp"],
      agentKit: { manifest } as unknown as PdmuxServices["agentKit"],
    });

    for (const request of [
      new Request("http://localhost/hosts"),
      new Request("http://localhost/fleet/events"),
      new Request("http://localhost/agent/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "pdmxe_ABCDE-FGHJK-MNPQR-STVWX" }),
      }),
      new Request("http://localhost/mcp", { method: "POST" }),
    ]) {
      const response = await app.handle(request);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "DATABASE_UNAVAILABLE" } });
    }
    expect(list).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();

    const kit = await app.handle(new Request("http://localhost/agent-kit/manifest"));
    expect(kit.status).toBe(200);
    expect(manifest).toHaveBeenCalledTimes(1);
  });
});
