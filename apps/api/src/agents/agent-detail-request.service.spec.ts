import { beforeEach, describe, expect, it } from "@jest/globals";
import { repoSnapshotSchema, type RepoSnapshot } from "@pdmux/protocol";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { GitDetailService } from "../git/git-detail.service";
import { GitIngestService } from "../git/git-ingest.service";
import { commitDetailKey } from "../git/git-storage";
import { GitService } from "../git/git.service";
import { RepoCommit } from "../git/repo-commit.entity";
import { RepoRef } from "../git/repo-ref.entity";
import { Repo } from "../git/repo.entity";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { FakeStorage } from "../testing/fake-storage";
import {
  AgentDetailRequestService,
  DETAIL_REQUEST_CAP,
  DETAIL_REQUEST_TTL_MS,
} from "./agent-detail-request.service";
import { AgentRegistryService, type AgentSocket } from "./agent-registry.service";

const ORG = "org-a";
const REPO_PATH = "/srv/demo-repo";
/** The credential the connection was accepted with; irrelevant here, but required. */
const TOKEN = "token-1";
const COLLECTED = "aaaaaaa1111111111111111111111111111111aa";
const PENDING = "bbbbbbb2222222222222222222222222222222bb";

interface DetailFrame {
  type: string;
  repoPath?: string;
  shas?: string[];
}

/** Records what the server wrote to one agent. */
class RecordingSocket implements AgentSocket {
  readonly sent: DetailFrame[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as DetailFrame);
  }

  close(): void {
    // Nothing to tear down: the spec drives `unregister` directly.
  }

  requests(): DetailFrame[] {
    return this.sent.filter((frame) => frame.type === "commitDetail");
  }
}

/** One collected commit and one that no pass has produced a patch for yet. */
function snapshot(pending: number): RepoSnapshot {
  return repoSnapshotSchema.parse({
    path: REPO_PATH,
    name: "demo-repo",
    ts: Math.floor(Date.now() / 1000),
    head: { branch: "main", sha: COLLECTED, detached: false },
    refs: [],
    commits: [
      { sha: COLLECTED, parents: [PENDING], refs: [], author: "dev", date: 1785000000, subject: "fix: thing" },
      { sha: PENDING, parents: [], refs: [], author: "dev", date: 1784900000, subject: "feat: other" },
    ],
    uncommitted: null,
    limit: 300,
    details: [{ sha: COLLECTED, subject: "fix: thing", body: "why", files: [] }],
    workingDiff: null,
    pending,
  });
}

/** The answer an agent sends back: details only, no graph (`partial: true`). */
function answer(sha: string, body: string): RepoSnapshot {
  return repoSnapshotSchema.parse({
    path: REPO_PATH,
    name: "demo-repo",
    ts: Math.floor(Date.now() / 1000),
    partial: true,
    details: [{ sha, subject: "fix: thing", body, files: [] }],
  });
}

async function build(pending = 1): Promise<{
  git: GitService;
  ingest: GitIngestService;
  registry: AgentRegistryService;
  service: AgentDetailRequestService;
  storage: FakeStorage;
  hostId: string;
  repoId: string;
}> {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(
    hostRepo.asRepository(),
    new FakeRepository<HostService>().asRepository(),
    gitRootRepo.asRepository(),
    settings,
    fakeAgentReleases(),
    fakeDataSource(),
  );
  const host = await hosts.create(ORG, { label: "build-01" });

  const repos = new FakeRepository<Repo>({ hasWorkingDiff: false, pendingDetails: 0, limit: 300 });
  const refs = new FakeRepository<RepoRef>();
  const commits = new FakeRepository<RepoCommit>({ hasDetail: false, detailEmpty: false, parents: [], refs: [] });
  const storage = new FakeStorage();
  const details = new GitDetailService(storage.asStorage());
  const ingest = new GitIngestService(repos.asRepository(), refs.asRepository(), commits.asRepository(), details);
  await ingest.ingest(host.id, [snapshot(pending)]);

  const git = new GitService(repos.asRepository(), refs.asRepository(), commits.asRepository(), details, hosts);
  const registry = new AgentRegistryService();
  // The seam under test: the requester registers itself on the git service from
  // the agents side, exactly as Nest does at startup.
  const service = new AgentDetailRequestService(git, registry);
  service.onModuleInit();

  return {
    git,
    ingest,
    registry,
    service,
    storage,
    hostId: host.id,
    repoId: (repos.rows[0] as unknown as Repo).id,
  };
}

describe("[TC-PDGIT-008] a click on an uncollected commit asks the agent for it", () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  let socket: RecordingSocket;

  beforeEach(async () => {
    ctx = await build();
    socket = new RecordingSocket();
  });

  it("[TC-PDGIT-008] asks the connected agent once, and still answers without waiting for it", async () => {
    ctx.registry.register(ctx.hostId, socket, TOKEN);

    const answer = await ctx.git.commitDetail(ORG, ctx.hostId, ctx.repoId, PENDING);

    // The read is answered from what is stored — the patch arrives later, on the
    // agent socket, through the ordinary ingest path.
    expect(answer).toEqual({ available: false, detail: null, pending: 1 });
    expect(socket.requests()).toEqual([{ type: "commitDetail", repoPath: REPO_PATH, shas: [PENDING] }]);
  });

  it("[TC-PDGIT-008] does not ask again while the first request is outstanding", async () => {
    ctx.registry.register(ctx.hostId, socket, TOKEN);

    // A browser polling the same missing detail: one request to the agent, not one
    // per poll.
    await ctx.git.commitDetail(ORG, ctx.hostId, ctx.repoId, PENDING);
    await ctx.git.commitDetail(ORG, ctx.hostId, ctx.repoId, PENDING);
    await ctx.git.commitDetail(ORG, ctx.hostId, ctx.repoId, PENDING);

    expect(socket.requests()).toHaveLength(1);
  });

  it("[TC-PDGIT-008] asks nothing for a patch it already has", async () => {
    ctx.registry.register(ctx.hostId, socket, TOKEN);

    const answer = await ctx.git.commitDetail(ORG, ctx.hostId, ctx.repoId, COLLECTED);

    expect(answer.available).toBe(true);
    expect(answer.detail?.body).toBe("why");
    expect(socket.sent).toEqual([]);
  });

  it("[TC-PDGIT-008] asks nothing when no agent is attached, and answers exactly as before", async () => {
    // Deliberately not registered: a frame written now would have no reader.
    expect(ctx.registry.isConnected(ctx.hostId)).toBe(false);

    const answer = await ctx.git.commitDetail(ORG, ctx.hostId, ctx.repoId, PENDING);

    expect(answer).toEqual({ available: false, detail: null, pending: 1 });
    expect(socket.sent).toEqual([]);
  });

  it("[TC-PDGIT-008] calls a commit it just asked for 'collecting', not 'missing'", async () => {
    // The collector believes it is done (`pending: 0`), and the stored object is
    // gone from under it — the case where the graph says `hasDetail` but the
    // bucket does not have it.
    const wiped = await build(0);
    wiped.registry.register(wiped.hostId, socket, TOKEN);
    wiped.storage.objects.delete(commitDetailKey(wiped.hostId, wiped.repoId, COLLECTED));

    const asked = await wiped.git.commitDetail(ORG, wiped.hostId, wiped.repoId, COLLECTED);

    // `pending: 0` renders as "missing — this will never appear", which would be a
    // lie one line after asking for it. One outstanding request is one commit
    // still being collected.
    expect(asked).toEqual({ available: false, detail: null, pending: 1 });
    expect(socket.requests()).toHaveLength(1);

    // With nobody to ask, "missing" is the truthful answer and the count stays put.
    const offline = await build(0);
    offline.storage.objects.delete(commitDetailKey(offline.hostId, offline.repoId, COLLECTED));
    expect(await offline.git.commitDetail(ORG, offline.hostId, offline.repoId, COLLECTED)).toEqual({
      available: false,
      detail: null,
      pending: 0,
    });
  });

  it("[TC-PDGIT-008] lets the answer it asked for actually land", async () => {
    const wiped = await build(0);
    wiped.registry.register(wiped.hostId, socket, TOKEN);
    // The row still says `hasDetail`, but the object is gone.
    wiped.storage.objects.delete(commitDetailKey(wiped.hostId, wiped.repoId, COLLECTED));

    await wiped.git.commitDetail(ORG, wiped.hostId, wiped.repoId, COLLECTED);
    expect(socket.requests()).toHaveLength(1);

    // The agent answers with a partial frame. Ingest drops a detail whose row says
    // "already stored" — so unless the read corrected that stale flag, the patch it
    // just asked for is discarded and the commit is unopenable for good.
    await wiped.ingest.ingest(wiped.hostId, [answer(COLLECTED, "rebuilt on request")]);

    const after = await wiped.git.commitDetail(ORG, wiped.hostId, wiped.repoId, COLLECTED);
    expect(after.available).toBe(true);
    expect(after.detail?.body).toBe("rebuilt on request");
    // And a hit asks for nothing more.
    expect(socket.requests()).toHaveLength(1);
  });

  it("[TC-PDGIT-008] retries once the outstanding marker expires", () => {
    ctx.registry.register(ctx.hostId, socket, TOKEN);
    const start = 1_800_000_000_000;

    expect(ctx.service.request(ctx.hostId, REPO_PATH, PENDING, start)).toBe(true);
    // Still waiting: the answer may simply be in flight.
    expect(ctx.service.request(ctx.hostId, REPO_PATH, PENDING, start + DETAIL_REQUEST_TTL_MS - 1)).toBe(true);
    expect(socket.requests()).toHaveLength(1);

    // The window passed with no answer — a dropped frame must not block the sha
    // forever.
    expect(ctx.service.request(ctx.hostId, REPO_PATH, PENDING, start + DETAIL_REQUEST_TTL_MS)).toBe(true);
    expect(socket.requests()).toHaveLength(2);
    expect(ctx.service.outstandingCount()).toBe(1);
  });

  it("[TC-PDGIT-008] forgets what it asked a host whose agent went away", () => {
    ctx.registry.register(ctx.hostId, socket, TOKEN);
    ctx.service.request(ctx.hostId, REPO_PATH, PENDING);
    expect(ctx.service.outstandingCount()).toBe(1);

    // The agent that was asked will never answer, and its replacement knows
    // nothing about the request.
    ctx.registry.unregister(ctx.hostId, socket);
    expect(ctx.service.outstandingCount()).toBe(0);

    const reconnected = new RecordingSocket();
    ctx.registry.register(ctx.hostId, reconnected, TOKEN);
    expect(ctx.service.request(ctx.hostId, REPO_PATH, PENDING)).toBe(true);
    expect(reconnected.requests()).toHaveLength(1);
  });

  it("[TC-PDGIT-008] keeps at most one frame's worth of requests in flight per host", () => {
    ctx.registry.register(ctx.hostId, socket, TOKEN);
    const shas = Array.from({ length: DETAIL_REQUEST_CAP + 10 }, (_, index) =>
      index.toString(16).padStart(40, "c"),
    );

    const asked = shas.filter((sha) => ctx.service.request(ctx.hostId, REPO_PATH, sha));

    // A script sweeping a whole window cannot queue a `git show` per commit.
    expect(asked).toHaveLength(DETAIL_REQUEST_CAP);
    expect(socket.requests()).toHaveLength(DETAIL_REQUEST_CAP);
    // Every frame stays within the contract's cap of 50 shas.
    for (const frame of socket.requests()) expect(frame.shas).toHaveLength(1);
  });
});
