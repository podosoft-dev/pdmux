import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentDownstream } from "@pdmux/protocol";
import type { GitService } from "../git/git.service";
import type { Repo } from "../git/repo.entity";
import { ACK_CHUNK, AgentAckService, chunkShas } from "./agent-ack.service";
import { AgentRegistryService, type AgentSocket } from "./agent-registry.service";

const HOST = "host-1";

class CapturingSocket implements AgentSocket {
  readonly frames: AgentDownstream[] = [];
  send(data: string): void {
    this.frames.push(JSON.parse(data) as AgentDownstream);
  }
  close(): void {
    /* not used */
  }
}

function gitStub(repos: { id: string; path: string }[], shas: Record<string, string[]>): GitService {
  return {
    listReposForHost: async () => repos as Repo[],
    collectedShas: async (repoId: string) => shas[repoId] ?? [],
  } as unknown as GitService;
}

describe("AgentAckService", () => {
  let registry: AgentRegistryService;
  let socket: CapturingSocket;

  beforeEach(() => {
    registry = new AgentRegistryService();
    socket = new CapturingSocket();
    registry.register(HOST, socket, "token-1");
  });

  it("[TC-PDAGENT-060] tells the agent which details this server already stores", async () => {
    const ack = new AgentAckService(
      gitStub(
        [
          { id: "repo-a", path: "/srv/demo-repo" },
          { id: "repo-b", path: "/home/ubuntu/other" },
        ],
        { "repo-a": ["aaaaaaa", "bbbbbbb"], "repo-b": [] },
      ),
      registry,
    );

    expect(await ack.ackAllRepos(HOST)).toBe(1);
    expect(socket.frames).toEqual([
      { type: "detailAck", repoPath: "/srv/demo-repo", shas: ["aaaaaaa", "bbbbbbb"] },
    ]);
    // A repo with nothing collected is not worth a frame.
    expect(socket.frames.filter((f) => f.type === "detailAck" && f.repoPath === "/home/ubuntu/other")).toEqual([]);
  });

  it("[TC-PDAGENT-060] chunks a window that exceeds the contract's 1000-sha cap", async () => {
    const many = Array.from({ length: 2300 }, (_, index) => `sha${String(index).padStart(7, "0")}`);
    const ack = new AgentAckService(
      gitStub([{ id: "repo-a", path: "/repo" }], { "repo-a": many }),
      registry,
    );

    expect(await ack.ackAllRepos(HOST)).toBe(3);
    const sizes = socket.frames.map((frame) => (frame.type === "detailAck" ? frame.shas.length : 0));
    expect(sizes).toEqual([ACK_CHUNK, ACK_CHUNK, 300]);
    // Every sha travels exactly once, in order.
    const flat = socket.frames.flatMap((frame) => (frame.type === "detailAck" ? frame.shas : []));
    expect(flat).toEqual(many);
  });

  it("[TC-PDAGENT-060] acks only the repos a pass stored details for, and stops when the agent leaves", async () => {
    const ack = new AgentAckService(
      gitStub(
        [
          { id: "repo-a", path: "/a" },
          { id: "repo-b", path: "/b" },
        ],
        { "repo-a": ["aaaaaaa"], "repo-b": ["bbbbbbb"] },
      ),
      registry,
    );

    expect(await ack.ackRepoPaths(HOST, ["/b"])).toBe(1);
    expect(socket.frames).toEqual([{ type: "detailAck", repoPath: "/b", shas: ["bbbbbbb"] }]);

    registry.unregister(HOST, socket);
    expect(await ack.ackAllRepos(HOST)).toBe(0);
    expect(await ack.ackRepoPaths(HOST, ["/a"])).toBe(0);
    expect(socket.frames).toHaveLength(1);
  });

  it("[TC-PDAGENT-060] chunkShas splits on the boundary and never emits an empty chunk", () => {
    expect(chunkShas([], 2)).toEqual([]);
    expect(chunkShas(["a", "b"], 2)).toEqual([["a", "b"]]);
    expect(chunkShas(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
});
