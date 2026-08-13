import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { FS_CHUNK_BYTES, type FsChunk, type FsRemoved, type FsWrote } from "@pdmux/protocol";
import type { Request, Response } from "express";

import type { AgentFilesService } from "./agent-files.service";
import { HostFilesController } from "./host-files.controller";

const HOST = "11111111-2222-3333-4444-555555555555";
const SESSION = { user: { id: "u1" }, session: { userId: "u1" } } as never;

/** A fake response that records what a browser would have been told and given. */
function fakeResponse() {
  const headers = new Map<string, string>();
  const written: Buffer[] = [];
  let status = 200;
  const response = {
    destroyed: false,
    setHeader: (name: string, value: string) => headers.set(name, value),
    getHeader: (name: string) => headers.get(name),
    status: (code: number) => {
      status = code;
      return response;
    },
    write: (chunk: Buffer) => {
      written.push(chunk);
      return true;
    },
    once: () => response,
    end: jest.fn(),
    destroy: jest.fn(() => {
      response.destroyed = true;
    }),
  };
  return {
    response: response as unknown as Response,
    headers,
    body: () => Buffer.concat(written).toString(),
    statusOf: () => status,
    ended: () => response.end,
  };
}

const request = (range?: string): Request => ({ headers: range ? { range } : {}, destroyed: false }) as Request;

/** A file the fake host serves in slices of `step` bytes. */
function hostServing(body: string, step = 4) {
  const chunk = jest.fn(
    async (_org: string, _host: string, path: string, offset: number): Promise<FsChunk> => {
      const raw = Buffer.from(body).subarray(offset, offset + step);
      return {
        requestId: "r",
        path,
        offset,
        data: raw.toString("base64"),
        size: Buffer.byteLength(body),
        eof: offset + raw.length >= Buffer.byteLength(body),
        error: null,
      };
    },
  );
  return { files: { chunk } as unknown as AgentFilesService, chunk };
}

describe("[TC-PDTERM-143] downloading a file streams it and answers Range", () => {
  let out: ReturnType<typeof fakeResponse>;

  beforeEach(() => {
    out = fakeResponse();
  });

  it("walks the file in slices and sends every byte", async () => {
    const { files, chunk } = hostServing("0123456789abc", 4);
    const controller = new HostFilesController(files);
    await controller.download(SESSION, HOST, request(), out.response, "notes/data.bin");

    expect(out.body()).toBe("0123456789abc");
    // ⚠ THE TAIL IS THE CASE THAT BREAKS: 13 bytes in slices of 4 means the last
    // one is short, and a loop that stops on a short read loses it.
    expect(chunk.mock.calls.map((call) => call[3])).toEqual([0, 4, 8, 12]);
    expect(out.headers.get("Content-Length")).toBe("13");
    expect(out.statusOf()).toBe(200);
  });

  it("starts where a resumed download asks it to", async () => {
    const { files, chunk } = hostServing("0123456789abc", 4);
    const controller = new HostFilesController(files);
    await controller.download(SESSION, HOST, request("bytes=8-"), out.response, "data.bin");

    // Nothing before the offset is read — that is the whole point of addressing
    // the agent by offset rather than streaming from the start and discarding.
    expect(chunk.mock.calls[0]?.[3]).toBe(8);
    expect(out.body()).toBe("89abc");
    expect(out.statusOf()).toBe(206);
    expect(out.headers.get("Content-Range")).toBe("bytes 8-12/13");
    expect(out.headers.get("Content-Length")).toBe("5");
  });

  it("refuses a range that starts past the end", async () => {
    const { files } = hostServing("short", 4);
    const controller = new HostFilesController(files);
    await controller.download(SESSION, HOST, request("bytes=99-"), out.response, "data.bin");
    expect(out.statusOf()).toBe(416);
    expect(out.headers.get("Content-Range")).toBe("bytes */5");
  });

  it("ignores a range header it does not understand rather than guessing", async () => {
    const { files, chunk } = hostServing("0123456789abc", 16);
    const controller = new HostFilesController(files);
    await controller.download(SESSION, HOST, request("bytes=0-1,4-5"), out.response, "data.bin");
    // A multi-range request is answered with the whole file, which is allowed and
    // honest; answering one range of several badly is not.
    expect(chunk.mock.calls[0]?.[3]).toBe(0);
    expect(out.statusOf()).toBe(200);
    expect(out.body()).toBe("0123456789abc");
  });
});

describe("[TC-PDTERM-144] what a browser is told to do with the bytes", () => {
  let out: ReturnType<typeof fakeResponse>;

  beforeEach(() => {
    out = fakeResponse();
  });

  const download = async (path: string, inline: string): Promise<void> => {
    const { files } = hostServing("bytes", 16);
    await new HostFilesController(files).download(SESSION, HOST, request(), out.response, path, inline);
  };

  it("attaches by default and names the file", async () => {
    await download("a/b/report card.pdf", "");
    expect(out.headers.get("Content-Type")).toBe("application/pdf");
    expect(out.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''report%20card.pdf");
  });

  it("renders a raster image inline when asked", async () => {
    await download("shots/screen.png", "1");
    expect(out.headers.get("Content-Type")).toBe("image/png");
    expect(out.headers.get("Content-Disposition")).toContain("inline;");
  });

  /**
   * ⚠ THE ONE THAT MATTERS. `inline` from this origin means the browser RUNS what
   * it renders, and both of these are documents that can carry script — with the
   * explorer itself as a way to put one on a host. Asking politely is not a
   * reason; the allowlist in `@pdmux/core` is.
   */
  it("refuses to render an SVG or an HTML file inline however it is asked", async () => {
    await download("icon.svg", "1");
    expect(out.headers.get("Content-Disposition")).toContain("attachment;");
    out = fakeResponse();
    await download("page.html", "1");
    expect(out.headers.get("Content-Disposition")).toContain("attachment;");
  });

  it("tells the browser not to sniff past what was declared", async () => {
    // The type is guessed from a NAME, and the name is chosen by whoever put the
    // file there — so sniffing is the browser overruling a guess with a guess.
    const meta = Reflect.getMetadata("__headers__", HostFilesController.prototype.download) as
      | { name: string; value: string }[]
      | undefined;
    expect(meta).toEqual(
      expect.arrayContaining([
        { name: "X-Content-Type-Options", value: "nosniff" },
        { name: "Accept-Ranges", value: "bytes" },
      ]),
    );
  });
});

/** A body delivered in whatever pieces the socket happened to produce. */
function bodyOf(pieces: (string | Buffer)[]): Request {
  return {
    headers: {},
    destroyed: false,
    async *[Symbol.asyncIterator]() {
      for (const piece of pieces) yield Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    },
  } as unknown as Request;
}

function hostAccepting() {
  const slices: { offset: number; length: number; create: boolean }[] = [];
  let size = 0;
  const put = jest.fn(
    async (_org: string, _host: string, path: string, offset: number, data: Buffer, create: boolean): Promise<FsWrote> => {
      slices.push({ offset, length: data.length, create });
      size = create ? data.length : Math.max(size, offset + data.length);
      return { requestId: "r", path, written: data.length, size, error: null };
    },
  );
  return { files: { put } as unknown as AgentFilesService, slices };
}

describe("[TC-PDTERM-147] an upload is streamed to the host in slices", () => {
  it("cuts the body at the frame cap however the socket delivered it", async () => {
    const { files, slices } = hostAccepting();
    // Pieces that do not line up with the cap — which is the normal case.
    const pieces = [Buffer.alloc(FS_CHUNK_BYTES - 10, 1), Buffer.alloc(30, 2), Buffer.alloc(5, 3)];
    const result = await new HostFilesController(files).upload(SESSION, HOST, bodyOf(pieces), "up/a.bin");

    expect(slices.map((slice) => slice.length)).toEqual([FS_CHUNK_BYTES, 25]);
    expect(slices.map((slice) => slice.offset)).toEqual([0, FS_CHUNK_BYTES]);
    // ⚠ ONLY THE FIRST SLICE TRUNCATES. `create` on every slice leaves a file
    // containing nothing but its last megabyte, and nothing errors to say so.
    expect(slices.map((slice) => slice.create)).toEqual([true, false]);
    expect(result.size).toBe(FS_CHUNK_BYTES + 25);
  });

  it("makes an empty file when the body is empty", async () => {
    const { files, slices } = hostAccepting();
    const result = await new HostFilesController(files).upload(SESSION, HOST, bodyOf([]), "up/empty.txt");
    // Uploading a zero-byte file is a real thing to do; answering nothing at all
    // would leave the panel unable to say whether it worked.
    expect(slices).toEqual([{ offset: 0, length: 0, create: true }]);
    expect(result.error).toBeNull();
  });

  it("stops at the first refusal instead of sending the rest", async () => {
    const put = jest.fn(async (): Promise<FsWrote> => ({
      requestId: "r",
      path: "up/a.bin",
      written: 0,
      size: 0,
      error: "permission denied",
    }));
    const controller = new HostFilesController({ put } as unknown as AgentFilesService);
    await expect(
      controller.upload(SESSION, HOST, bodyOf([Buffer.alloc(FS_CHUNK_BYTES * 2)]), "up/a.bin"),
    ).rejects.toThrow(/permission denied/);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe("[TC-PDTERM-148] deleting says which of the two things it is doing", () => {
  const removing = () => {
    const remove = jest.fn(
      async (_org: string, _host: string, path: string, recursive: boolean): Promise<FsRemoved> => ({
        requestId: "r",
        path,
        removed: recursive ? 12 : 1,
        error: null,
      }),
    );
    return { files: { remove } as unknown as AgentFilesService, remove };
  };

  it("passes `recursive` through as the caller asked, never inferring it", async () => {
    const { files, remove } = removing();
    const controller = new HostFilesController(files);
    await controller.remove(SESSION, HOST, "a/b.txt", "");
    expect(remove.mock.calls[0]?.[3]).toBe(false);
    await controller.remove(SESSION, HOST, "a/dir", "1");
    expect(remove.mock.calls[1]?.[3]).toBe(true);
  });

  it("refuses an empty path before it reaches a host", () => {
    const { files, remove } = removing();
    // It throws SYNCHRONOUSLY, before any promise exists — which is the point:
    // nothing is dispatched to a host at all.
    expect(() => new HostFilesController(files).remove(SESSION, HOST, "", "1")).toThrow(/path is required/);
    // ⚠ An empty path is the HOME directory. The agent refuses it too, but a
    // refusal that never leaves this process is the better one.
    expect(remove).not.toHaveBeenCalled();
  });

  it("audits that a delete happened, and never what was in the file", () => {
    const meta = Reflect.getMetadata("podokit:audit", HostFilesController.prototype.remove) as
      | { action: string; resolve?: (req: unknown, result: unknown) => unknown }
      | undefined;
    expect(meta?.action).toBe("host.files.delete");
    const target = meta?.resolve?.({ params: { hostId: HOST }, query: { path: "a/b.txt", recursive: "1" } }, null);
    expect(target).toEqual({ type: "host", id: HOST, label: "a/b.txt", metadata: { recursive: true } });
  });
});
