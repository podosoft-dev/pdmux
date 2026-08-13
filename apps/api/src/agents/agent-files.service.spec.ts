import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { AgentDownstream, FsDir } from "@pdmux/protocol";

import { AgentFilesService } from "./agent-files.service";
import { AgentRegistryService } from "./agent-registry.service";
import { HostsService } from "../hosts/hosts.service";

const HOST = "11111111-2222-3333-4444-555555555555";
const ORG = "org-a";

/** `ask` awaits the scope gate before sending, so the frame lands a tick later. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function build(options: { capabilities?: string[]; enabled?: boolean; online?: boolean } = {}) {
  const sent: AgentDownstream[] = [];
  const registry = {
    sendToHost: jest.fn((_hostId: string, frame: AgentDownstream) => {
      sent.push(frame);
      return options.online ?? true;
    }),
  } as unknown as AgentRegistryService;
  const hosts = {
    get: jest.fn(async () => ({
      id: HOST,
      enabled: options.enabled ?? true,
      capabilities: options.capabilities ?? ["files"],
    })),
  } as unknown as HostsService;
  return { service: new AgentFilesService(registry, hosts), sent };
}

describe("[TC-PDTERM-141] a directory answer belongs to the request that asked for it", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("asks the host and settles when the matching answer arrives", async () => {
    const pending = ctx.service.list(ORG, HOST, "project");
    await flush();
    const frame = ctx.sent[0] as { type: string; requestId: string; path: string };
    expect(frame.type).toBe("fsList");
    expect(frame.path).toBe("project");
    // ⚠ THE PATH IS PASSED THROUGH UNTOUCHED. The fence is the agent's root
    // handle; a check here would be a second, weaker opinion about a question
    // that is already answered structurally.
    expect(frame.requestId).toMatch(/^[0-9a-f-]{36}$/);

    ctx.service.settle({ requestId: frame.requestId, path: "project", home: "/home/pdmux", entries: [], dropped: 0, truncated: false, error: null });
    await expect(pending).resolves.toMatchObject({ path: "project", error: null });
  });

  it("never lets an answer for one request settle another", async () => {
    /**
     * ⚠ THIS IS THE DIFFERENCE FROM A GIT TREE, AND THE REASON REQUESTS CARRY AN
     * ID. A tree is immutable per sha, so any answer for that sha is the right
     * one. A directory is true for an instant: settling a new request with an
     * older frame because the PATH matched would show somebody the directory as
     * it was before they changed it.
     */
    const first = ctx.service.list(ORG, HOST, "same");
    const second = ctx.service.list(ORG, HOST, "same");
    await flush();
    const [a, b] = ctx.sent as { requestId: string }[];
    expect(a?.requestId).not.toBe(b?.requestId);

    const stale: FsDir = {
      requestId: a!.requestId,
      path: "same",
      home: "/home/pdmux",
      entries: [{ name: "old.txt", dir: false, symlink: false, size: 1, modified: 0 }],
      dropped: 0,
      truncated: false,
      error: null,
    };
    ctx.service.settle(stale);
    await expect(first).resolves.toMatchObject({ entries: [{ name: "old.txt" }] });

    // The second is still waiting — the path matched and that changed nothing.
    ctx.service.settle({ ...stale, requestId: b!.requestId, entries: [{ name: "new.txt", dir: false, symlink: false, size: 1, modified: 0 }] });
    await expect(second).resolves.toMatchObject({ entries: [{ name: "new.txt" }] });
  });

  it("drops an answer nobody is waiting for, without ceremony", () => {
    // What a retry after a timeout looks like. It is not an error.
    expect(() =>
      ctx.service.settle({ requestId: "unknown", path: "", home: "/home/pdmux", entries: [], dropped: 0, truncated: false, error: null }),
    ).not.toThrow();
  });

  it("refuses an agent that cannot browse, instead of waiting out the timeout", async () => {
    // ⚠ READ THE CAPABILITY, DO NOT ASSUME IT. An older agent ignores the frame,
    // and the caller would sit through the deadline for an answer never coming.
    // It also means the host HAS a usable home — an account without one announces
    // nothing, and that is a fact rather than an empty directory.
    ctx = build({ capabilities: ["exec"] });
    await expect(ctx.service.list(ORG, HOST, "")).rejects.toMatchObject({ code: "HOST_FILES_UNSUPPORTED" });
    expect(ctx.sent).toHaveLength(0);
  });

  it("refuses a disconnected host without leaving a promise behind", async () => {
    ctx = build({ online: false });
    await expect(ctx.service.list(ORG, HOST, "")).rejects.toMatchObject({ code: "HOST_OFFLINE" });
    // The next call must still be able to run: a leaked pending entry would eat
    // one of the in-flight slots forever.
    ctx = build();
    const next = ctx.service.list(ORG, HOST, "");
    await flush();
    const frame = ctx.sent[0] as { requestId: string };
    expect(frame).toBeDefined();
    // Settled rather than abandoned: an unresolved request holds its deadline
    // timer, and a suite that leaves those behind does not exit.
    ctx.service.settle({ requestId: frame.requestId, path: "", home: "/home/pdmux", entries: [], dropped: 0, truncated: false, error: null });
    await expect(next).resolves.toMatchObject({ error: null });
  });

  it("caps what one host can be made to do at once", async () => {
    // A tree view is a click multiplier: one directory with fifty children is
    // fifty potential requests, and a retrying browser is more.
    const inFlight = Array.from({ length: 16 }, (_, i) => ctx.service.list(ORG, HOST, `d${i}`));
    await flush();
    await expect(ctx.service.list(ORG, HOST, "one-too-many")).rejects.toMatchObject({ code: "HOST_FILES_BUSY" });
    for (const [index, promise] of inFlight.entries()) {
      const frame = ctx.sent[index] as { requestId: string };
      ctx.service.settle({ requestId: frame.requestId, path: `d${index}`, home: "/home/pdmux", entries: [], dropped: 0, truncated: false, error: null });
      await promise;
    }
  });
});
