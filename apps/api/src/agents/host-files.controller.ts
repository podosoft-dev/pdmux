import { Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import type { Request, Response } from "express";
import type { FsDir, FsFile, FsRemoved, FsWrote } from "@pdmux/protocol";
import { FS_CAPS, FS_CHUNK_BYTES } from "@pdmux/protocol";
import { inlineSafe, mimeOf } from "@pdmux/core";

import { AgentFilesService } from "./agent-files.service";
import { AppException } from "../common/app-exception";
import { resolveScopeId } from "../fleet/session-scope";
import { Audit } from "../audit/audit.decorator";

/**
 * Browsing a host's files, under the agent user's home directory.
 *
 * ⚠ THIS IS NOT A NEW POWER, AND THAT IS WHY IT EXISTS. Whoever can reach this
 * route can already open a terminal on the same host as the same account and
 * `cat` anything it reaches — so the explorer is a nicer way to do what a pane
 * already does. It is offered to a person in a browser and to nobody else.
 *
 * ⚠ AN MCP CREDENTIAL MUST NEVER REACH IT. A token with no terminal is a
 * different question with a different answer: giving file reads to a tier that
 * cannot open a pane would create access rather than restate it. Nothing here
 * enforces that — the MCP gateway ENUMERATES its tools and does not proxy REST
 * (`docs/MCP.md` §2), so a new route is not automatically a new grant. That is a
 * property of the architecture, and this comment exists so nobody "helpfully"
 * proxies the controller surface later.
 *
 * ⚠ IT LIVES IN THE AGENTS MODULE THOUGH ITS ROUTE READS `hosts/…`. The answer
 * comes from an agent socket, and `AgentsModule` already imports `HostsModule`
 * for the scope gate — putting it the other way round would make the two modules
 * import each other. A URL is not a module boundary.
 *
 * ⚠ THE FENCE IS NOT HERE. It is the agent's `os.Root` handle, which resolves
 * every name inside the home and cannot leave it — `..`, an absolute path and a
 * symlink pointing out are impossible rather than rejected. This layer therefore
 * validates only the LENGTH: a check here would be a second, weaker opinion
 * about a question that is already answered structurally, and the first thing to
 * rot when somebody changes one side.
 */
@ApiTags("hosts")
@Controller("hosts/:hostId/files")
export class HostFilesController {
  constructor(private readonly files: AgentFilesService) {}

  /**
   * ⚠ THE PATH IS A QUERY PARAMETER, NOT A ROUTE SEGMENT — the reason the git
   * controller records: a path contains slashes, so as a segment it would need
   * double encoding and would still collide with the route. An absent path is the
   * home directory itself.
   */
  @Get()
  list(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Query("path") path = "",
  ): Promise<FsDir> {
    return this.files.list(resolveScopeId(session), hostId, assertPath(path));
  }

  @Get("content")
  read(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Query("path") path = "",
  ): Promise<FsFile> {
    const clean = assertPath(path);
    if (clean.length === 0) {
      throw new AppException("FILE_PATH_REQUIRED", "A file path is required", 400);
    }
    return this.files.read(resolveScopeId(session), hostId, clean);
  }

  /**
   * The file's BYTES, streamed — a download, or the `src` of an image preview.
   *
   * ⚠ THE BROWSER IS THE DOWNLOAD MANAGER, DELIBERATELY. Progress, "cancel", the
   * downloads shelf and a resume after a dropped connection are all things Chrome
   * and Safari already do well, and doing them in the page would mean holding the
   * whole file in memory to hand back a blob URL — the one thing that breaks on
   * exactly the large files the feature is for. So this answers `Range`, sets
   * `Accept-Ranges`, and gets out of the way.
   *
   * ⚠ RESUME COSTS NOTHING BECAUSE THE AGENT IS OFFSET-ADDRESSED. A `Range` that
   * starts at 40 MB asks the host for the slice at 40 MB; nothing before it is
   * read, nothing was held open in between, and a browser that never comes back
   * leaves no state on the host.
   */
  @Get("download")
  @Header("Accept-Ranges", "bytes")
  // ⚠ The browser must not sniff its way past what we declared: the type is
  // guessed from a NAME, and a name is chosen by whoever put the file there.
  @Header("X-Content-Type-Options", "nosniff")
  async download(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Req() request: Request,
    @Res() response: Response,
    @Query("path") path = "",
    @Query("inline") inline = "",
  ): Promise<void> {
    const clean = assertPath(path);
    if (clean.length === 0) {
      throw new AppException("FILE_PATH_REQUIRED", "A file path is required", 400);
    }
    const scope = resolveScopeId(session);
    const name = clean.split("/").pop() ?? "download";
    const mime = mimeOf(name);

    // The first slice answers two questions at once: whether the file can be read
    // at all, and how big it is — so the headers below are facts, not guesses.
    const from = parseRangeStart(request.headers.range);
    const first = await this.files.chunk(scope, hostId, clean, from, FS_CHUNK_BYTES);
    if (first.error) {
      throw new AppException("FILE_READ_FAILED", first.error, 502);
    }
    if (from > 0 && from >= first.size) {
      response.status(416).setHeader("Content-Range", `bytes */${first.size}`);
      response.end();
      return;
    }

    /**
     * ⚠ ATTACHMENT UNLESS THE TYPE IS ON THE ALLOWLIST, never merely because the
     * caller asked. `inline` from this origin turns any renderable file into
     * content running as the app — an SVG carries script, an HTML file plainly is
     * script — and the explorer is a way to put such a file on a host. Raster
     * images only, and `@pdmux/core` owns that list so the rule is testable.
     */
    const asInline = inline === "1" && inlineSafe(mime);
    response.setHeader("Content-Type", mime);
    response.setHeader(
      "Content-Disposition",
      `${asInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    if (from > 0) {
      response.status(206);
      response.setHeader("Content-Range", `bytes ${from}-${Math.max(first.size - 1, from)}/${first.size}`);
    }
    response.setHeader("Content-Length", String(Math.max(first.size - from, 0)));

    let offset = from;
    let slice = first;
    for (;;) {
      const raw = Buffer.from(slice.data, "base64");
      if (raw.length > 0 && !(await write(response, raw))) return; // the client left
      offset += raw.length;
      if (slice.eof || raw.length === 0) break;
      // ⚠ THE ABORT CHECK IS BEFORE THE NEXT ASK, not after. A cancelled download
      // of a 2 GB file would otherwise keep the host busy producing slices nobody
      // is reading, one request at a time, to the end.
      if (response.destroyed || request.destroyed) return;
      slice = await this.files.chunk(scope, hostId, clean, offset, FS_CHUNK_BYTES);
      if (slice.error) {
        // The headers are long gone, so there is no status left to set: cutting
        // the response is what tells the browser the file is incomplete.
        response.destroy();
        return;
      }
    }
    response.end();
  }

  /**
   * Upload one file into the directory the panel is showing.
   *
   * ⚠ THE BODY IS READ AS A STREAM AND FORWARDED IN SLICES, never buffered whole.
   * A 2 GB upload must not become 2 GB of API memory, and slicing here is also
   * what makes the agent side offset-addressed rather than session-shaped.
   *
   * ⚠ WHAT IS AUDITED IS THAT A FILE WAS WRITTEN AND WHERE — never a byte of it,
   * and not a preview. An upload is the surface most likely to carry a secret,
   * which is the rule the MCP gateway already states for command arguments.
   */
  @Post("upload")
  @Audit("host.files.upload", (req) => ({
    type: "host",
    id: String(req.params.hostId),
    label: String(req.query.path ?? ""),
  }))
  async upload(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Req() request: Request,
    @Query("path") path = "",
  ): Promise<FsWrote> {
    const clean = assertPath(path);
    if (clean.length === 0) {
      throw new AppException("FILE_PATH_REQUIRED", "A file path is required", 400);
    }
    const scope = resolveScopeId(session);

    let offset = 0;
    let create = true;
    let last: FsWrote | null = null;
    let buffered: Buffer[] = [];
    let buffies = 0;

    const flush = async (): Promise<void> => {
      if (buffies === 0) return;
      const slice = Buffer.concat(buffered, buffies);
      buffered = [];
      buffies = 0;
      const wrote = await this.files.put(scope, hostId, clean, offset, slice, create);
      if (wrote.error) throw new AppException("FILE_WRITE_FAILED", wrote.error, 502);
      offset += slice.length;
      create = false;
      last = wrote;
    };

    // ⚠ `Content-Type: application/octet-stream` IS PART OF THE CONTRACT WITH THE
    // BODY PARSER. Express parses `application/json` and form bodies before a
    // handler runs; an octet-stream body it leaves alone, which is what lets this
    // read the socket itself instead of receiving a 2 GB string.
    for await (const piece of request) {
      const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(String(piece));
      buffered.push(buffer);
      buffies += buffer.length;
      // ⚠ AT the cap, not past it: the contract bounds one frame, and a slice that
      // arrives 3 bytes over is a rejected frame rather than a smaller write.
      while (buffies >= FS_CHUNK_BYTES) {
        const joined = Buffer.concat(buffered, buffies);
        const slice = joined.subarray(0, FS_CHUNK_BYTES);
        buffered = [joined.subarray(FS_CHUNK_BYTES)];
        buffies = buffered[0]?.length ?? 0;
        const wrote = await this.files.put(scope, hostId, clean, offset, slice, create);
        if (wrote.error) throw new AppException("FILE_WRITE_FAILED", wrote.error, 502);
        offset += slice.length;
        create = false;
        last = wrote;
      }
    }
    await flush();

    // An empty upload is still a file — `create` alone makes it, so the caller
    // that sent nothing gets an empty file rather than silence.
    if (!last) {
      const wrote = await this.files.put(scope, hostId, clean, 0, Buffer.alloc(0), true);
      if (wrote.error) throw new AppException("FILE_WRITE_FAILED", wrote.error, 502);
      return wrote;
    }
    return last;
  }

  /**
   * Delete one entry.
   *
   * ⚠ `recursive` IS AN EXPLICIT PARAMETER AND STAYS ONE. The confirmation the UI
   * shows says which of the two things is about to happen, and it can only say so
   * because the two are different requests — a server that inferred it from the
   * path being a directory would make the dialog a guess.
   */
  @Delete()
  @HttpCode(200)
  @Audit("host.files.delete", (req) => ({
    type: "host",
    id: String(req.params.hostId),
    label: String(req.query.path ?? ""),
    metadata: { recursive: req.query.recursive === "1" },
  }))
  remove(
    @Session() session: UserSession,
    @Param("hostId", ParseUUIDPipe) hostId: string,
    @Query("path") path = "",
    @Query("recursive") recursive = "",
  ): Promise<FsRemoved> {
    const clean = assertPath(path);
    if (clean.length === 0) {
      // The home directory itself, which the agent refuses anyway — but a refusal
      // that never leaves this process is a better one.
      throw new AppException("FILE_PATH_REQUIRED", "A file path is required", 400);
    }
    return this.files.remove(resolveScopeId(session), hostId, clean, recursive === "1");
  }
}

/**
 * The start of a single byte range, or 0.
 *
 * ⚠ ONLY THE START, AND ONLY ONE RANGE. A browser resuming a download sends
 * `bytes=N-`; multi-range requests are for viewers seeking inside a media file,
 * and answering one badly is worse than answering the whole file — which is what
 * an unparsed header falls back to.
 */
function parseRangeStart(header: string | undefined): number {
  const match = /^bytes=(\d+)-\d*$/.exec((header ?? "").trim());
  if (!match) return 0;
  const start = Number(match[1]);
  return Number.isSafeInteger(start) && start >= 0 ? start : 0;
}

/** One write, with back-pressure. `false` means the client is gone. */
function write(response: Response, chunk: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    if (response.destroyed) return resolve(false);
    if (response.write(chunk)) return resolve(true);
    response.once("drain", () => resolve(!response.destroyed));
    response.once("close", () => resolve(false));
  });
}

/** The only check this layer makes, and it is about the frame, not about safety. */
function assertPath(path: string): string {
  if (typeof path !== "string" || path.length > FS_CAPS.maxPathChars) {
    throw new AppException("FILE_PATH_INVALID", "Invalid file path", 400);
  }
  return path;
}
