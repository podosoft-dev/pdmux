import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import {
  FS_CHUNK_BYTES,
  type AgentDownstream,
  type FsChunk,
  type FsDir,
  type FsFile,
  type FsRemoved,
  type FsWrote,
} from "@pdmux/protocol";

import { AppException } from "../common/app-exception";
import { HostsService } from "../hosts/hosts.service";
import { AgentRegistryService } from "./agent-registry.service";

/**
 * One directory listing or one file, out to an agent and back.
 *
 * WHY THIS IS PAIRED AND NOT STORED, which is the whole difference from the git
 * tree beside it: a tree is immutable per sha, so the server asks once, keeps the
 * answer forever and every later reader is a cache hit. A directory is true for
 * an INSTANT. Somebody creating a file and refreshing must see it, so there is
 * nothing to store and nothing to coalesce — the request waits for its own
 * answer, the way `exec` does, and this service is that pairing.
 *
 * ⚠ AND THE ANSWER IS MATCHED BY ID, NEVER BY PATH. Two reads of one path a
 * second apart are different answers; settling a new request with an old frame
 * because the path matched would show somebody a directory as it was before they
 * changed it, which is the one failure this feature cannot have.
 */

/** Long enough for a cold disk, short enough that a wedged host is not a hang. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * ⚠ A SLICE GETS LONGER THAN A LISTING DOES, and the reason is arithmetic. A
 * megabyte over a home connection is seconds, not milliseconds, so the listing's
 * budget would abort a transfer that was working perfectly. It still bounds the
 * wait: a download that stalls stops, it does not hang.
 */
const CHUNK_TIMEOUT_MS = 30_000;

/**
 * ⚠ A CEILING, BECAUSE A TREE VIEW IS A CLICK MULTIPLIER. Opening a directory
 * with fifty subdirectories is fifty potential requests, and a browser that
 * retries is more. This bounds what one host can be made to do at once; the
 * refusal is an answer, which is the rule `exec` states for the same reason.
 */
const MAX_IN_FLIGHT_PER_HOST = 16;

/** Everything an agent can answer a file request with. */
export type FsAnswer = FsDir | FsFile | FsChunk | FsWrote | FsRemoved;

interface Pending<T> {
  resolve: (value: T) => void;
  timer: NodeJS.Timeout;
  hostId: string;
}

@Injectable()
export class AgentFilesService {
  private readonly logger = new Logger(AgentFilesService.name);
  private readonly pending = new Map<string, Pending<FsAnswer>>();

  constructor(
    private readonly registry: AgentRegistryService,
    private readonly hosts: HostsService,
  ) {}

  /**
   * Called from the ingest path when an answer arrives.
   *
   * An id we are not waiting for is dropped without ceremony: that is what a
   * retry after a timeout looks like, and it is not an error.
   */
  settle(answer: FsAnswer): void {
    const waiter = this.pending.get(answer.requestId);
    if (!waiter) return;
    this.pending.delete(answer.requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(answer);
  }

  list(organizationId: string, hostId: string, path: string): Promise<FsDir> {
    return this.ask<FsDir>(organizationId, hostId, (requestId) => ({ type: "fsList", requestId, path }), (requestId) => ({
      requestId,
      path,
      home: "",
      entries: [],
      dropped: 0,
      truncated: false,
      error: "The host did not answer before the deadline",
    }));
  }

  read(organizationId: string, hostId: string, path: string): Promise<FsFile> {
    return this.ask<FsFile>(organizationId, hostId, (requestId) => ({ type: "fsRead", requestId, path }), (requestId) => ({
      requestId,
      path,
      lines: [],
      binary: false,
      truncated: false,
      bytes: 0,
      error: "The host did not answer before the deadline",
    }));
  }

  /**
   * One slice of a file, as BYTES.
   *
   * ⚠ THE CALLER LOOPS; THIS DOES NOT. Streaming a whole file from here would
   * mean this service knew about HTTP responses, back-pressure and aborted
   * downloads — it knows about one question and one answer, and the controller
   * that owns the response owns the loop.
   */
  chunk(organizationId: string, hostId: string, path: string, offset: number, length: number): Promise<FsChunk> {
    const want = Math.max(0, Math.min(Math.trunc(length), FS_CHUNK_BYTES));
    return this.ask<FsChunk>(
      organizationId,
      hostId,
      (requestId): AgentDownstream => ({ type: "fsGet", requestId, path, offset, length: want }),
      (requestId) => ({
        requestId,
        path,
        offset,
        data: "",
        size: 0,
        eof: true,
        error: "The host did not answer before the deadline",
      }),
      CHUNK_TIMEOUT_MS,
    );
  }

  /**
   * Write one slice of an upload.
   *
   * ⚠ THE CALLER SLICES AND LOOPS, as with `chunk` — and `create` belongs to the
   * FIRST slice only. Setting it on every slice would truncate the file each time
   * and leave a upload containing nothing but its last megabyte, with no error
   * anywhere to say so.
   */
  put(
    organizationId: string,
    hostId: string,
    path: string,
    offset: number,
    data: Buffer,
    create: boolean,
  ): Promise<FsWrote> {
    return this.ask<FsWrote>(
      organizationId,
      hostId,
      (requestId): AgentDownstream => ({
        type: "fsPut",
        requestId,
        path,
        offset,
        data: data.toString("base64"),
        create,
      }),
      (requestId) => ({
        requestId,
        path,
        written: 0,
        size: 0,
        error: "The host did not answer before the deadline",
      }),
      CHUNK_TIMEOUT_MS,
    );
  }

  remove(organizationId: string, hostId: string, path: string, recursive: boolean): Promise<FsRemoved> {
    return this.ask<FsRemoved>(
      organizationId,
      hostId,
      (requestId): AgentDownstream => ({ type: "fsDelete", requestId, path, recursive }),
      (requestId) => ({
        requestId,
        path,
        removed: 0,
        error: "The host did not answer before the deadline",
      }),
      // A recursive delete of a large tree is disk work, not a network round trip.
      CHUNK_TIMEOUT_MS,
    );
  }

  private async ask<T extends FsAnswer>(
    organizationId: string,
    hostId: string,
    build: (requestId: string) => AgentDownstream,
    onTimeout: (requestId: string) => T,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    // Through the scope gate, so this cannot reach a host outside the session's.
    const host = await this.hosts.get(organizationId, hostId);
    if (!host.enabled) throw new AppException("HOST_DISABLED", "This host is disabled", 409);

    /**
     * ⚠ READ THE CAPABILITY, DO NOT ASSUME IT. An agent built before this ignores
     * the frame, and the caller would wait out the timeout for an answer that was
     * never coming. It also means the host HAS a usable home — an account without
     * one announces nothing, and "there is nowhere to browse" is a better sentence
     * than an empty directory.
     */
    if (!host.capabilities?.includes("files")) {
      throw new AppException(
        "HOST_FILES_UNSUPPORTED",
        "This host's agent cannot browse files yet. Update it from the dashboard.",
        409,
      );
    }

    const inFlight = [...this.pending.values()].filter((entry) => entry.hostId === hostId).length;
    if (inFlight >= MAX_IN_FLIGHT_PER_HOST) {
      throw new AppException("HOST_FILES_BUSY", "Too many file requests are already in flight", 429);
    }

    const requestId = randomUUID();
    const answered = new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        // ⚠ A TIMEOUT IS AN ANSWER, NOT A THROW. The reason travels in the same
        // shape as any other failure so one renderer handles both — the rule
        // `GitTree.error` records: a caller left with nothing reads it as a lost
        // click rather than as a host that did not reply.
        resolve(onTimeout(requestId));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (value: FsAnswer) => void, timer, hostId });
    });

    const frame = build(requestId);
    if (!this.registry.sendToHost(hostId, frame)) {
      const waiter = this.pending.get(requestId);
      if (waiter) {
        this.pending.delete(requestId);
        clearTimeout(waiter.timer);
      }
      throw new AppException("HOST_OFFLINE", "This host's agent is not connected", 409);
    }

    this.logger.debug(`Asked ${hostId} for ${frame.type}`);
    return answered;
  }
}
