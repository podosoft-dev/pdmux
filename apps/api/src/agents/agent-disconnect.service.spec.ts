import {
  AGENT_CLOSE_HOST_DELETED,
  AGENT_CLOSE_HOST_DISABLED,
  AGENT_CLOSE_REPLACED,
  AGENT_CLOSE_TOKEN_REVOKED,
} from "@pdmux/protocol";
import { beforeEach, describe, expect, it } from "@jest/globals";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { AgentDisconnectService } from "./agent-disconnect.service";
import {
  AgentRegistryService,
  type AgentSocket,
} from "./agent-registry.service";
import { AgentToken } from "./agent-token.entity";
import { AgentTokensService } from "./agent-tokens.service";

const ORG_A = "org-a";
const ORG_B = "org-b";

/** An agent socket that remembers how it was hung up on — and can refuse to be. */
class RecordingSocket implements AgentSocket {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  /** Mimics a socket already tearing down: `close()` throws at the caller. */
  closeThrows = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closeThrows) throw new Error("socket already destroyed");
    this.closed = { code, reason };
  }
}

function build(): {
  hosts: HostsService;
  tokens: AgentTokensService;
  registry: AgentRegistryService;
  disconnects: string[];
} {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const serviceRepo = new FakeRepository<HostService>();
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(
    hostRepo.asRepository(),
    serviceRepo.asRepository(),
    gitRootRepo.asRepository(),
    settings,
    fakeAgentReleases(),
    fakeDataSource(),
  );
  const registry = new AgentRegistryService();
  const tokenRows = new FakeRepository<AgentToken>({ lastUsedAt: null, revokedAt: null, createdAt: new Date() });
  const disconnect = new AgentDisconnectService(hosts, registry);
  // The seam under test: the agents side subscribes to the hosts service at
  // startup, exactly as Nest does — `hosts` never learns this module exists.
  disconnect.onModuleInit();
  const tokens = new AgentTokensService(tokenRows.asRepository(), hosts, disconnect);
  const disconnects: string[] = [];
  registry.onHostDisconnect((hostId, reason) => disconnects.push(`${hostId}:${reason}`));
  return { hosts, tokens, registry, disconnects };
}

describe("[TC-PDHOST-013] disabling a host hangs up on the agent that is connected now", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDHOST-013] closes exactly that host's socket, with a code that is not the replace code", async () => {
    const parked = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const running = await ctx.hosts.create(ORG_A, { label: "build-02" });
    const foreign = await ctx.hosts.create(ORG_B, { label: "other-org" });
    const parkedSocket = new RecordingSocket();
    const runningSocket = new RecordingSocket();
    const foreignSocket = new RecordingSocket();
    ctx.registry.register(parked.id, parkedSocket, "token-parked");
    ctx.registry.register(running.id, runningSocket, "token-running");
    ctx.registry.register(foreign.id, foreignSocket, "token-foreign");

    const saved = await ctx.hosts.setEnabled(ORG_A, parked.id, false);
    expect(saved.enabled).toBe(false);

    // The whole point: the live connection is gone, not just the next one refused.
    expect(parkedSocket.closed?.code).toBe(AGENT_CLOSE_HOST_DISABLED);
    expect(parkedSocket.closed?.reason).toBe("host disabled");
    // Distinguishable from "the same agent dialled again", so a log tells them apart.
    expect(parkedSocket.closed?.code).not.toBe(AGENT_CLOSE_REPLACED);
    expect(ctx.registry.isConnected(parked.id)).toBe(false);

    // Nobody else is touched — not the neighbour, not another organization.
    expect(runningSocket.closed).toBeNull();
    expect(foreignSocket.closed).toBeNull();
    expect(ctx.registry.connectedHostIds().sort()).toEqual([running.id, foreign.id].sort());

    // Exactly one disconnect reaches the terminal relay: the PTYs on that socket
    // are dead and the panes must be told, but only once.
    expect(ctx.disconnects).toEqual([`${parked.id}:closed`]);
  });

  it("[TC-PDHOST-013] does the same through PATCH /hosts/:id, the toggle operators actually use", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const socket = new RecordingSocket();
    ctx.registry.register(host.id, socket, "token-1");

    // An unrelated edit must not disturb a healthy connection.
    await ctx.hosts.update(ORG_A, host.id, { description: "rack 3" });
    expect(socket.closed).toBeNull();
    expect(ctx.registry.isConnected(host.id)).toBe(true);

    await ctx.hosts.update(ORG_A, host.id, { enabled: false });
    expect(socket.closed?.code).toBe(AGENT_CLOSE_HOST_DISABLED);
    expect(ctx.registry.isConnected(host.id)).toBe(false);
  });

  it("[TC-PDHOST-013] re-enabling needs nothing but the toggle: the agent's own reconnect is authorized again", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.tokens.mint(ORG_A, host.id, "laptop");
    const first = new RecordingSocket();
    ctx.registry.register(host.id, first, minted.id);
    await ctx.hosts.setEnabled(ORG_A, host.id, false);

    const enabled = await ctx.hosts.setEnabled(ORG_A, host.id, true);

    // Enabling closes nothing and sends nothing — there is no connection to fix.
    expect(enabled.enabled).toBe(true);
    expect(ctx.disconnects).toEqual([`${host.id}:closed`]);
    // The credential survived the park, which is the point of refusing the upgrade
    // instead of revoking: no reinstall, no new token, no touch on the machine.
    expect((await ctx.tokens.resolve(minted.token))?.hostId).toBe(host.id);
    expect((await ctx.tokens.list(ORG_A, host.id)).filter((row) => row.revokedAt !== null)).toEqual([]);
    // And the gateway's own precondition — the row the upgrade reads — now passes.
    expect((await ctx.hosts.getById(host.id))?.enabled).toBe(true);

    // The agent comes back on its own backoff; nothing else was required.
    const reconnected = new RecordingSocket();
    ctx.registry.register(host.id, reconnected, minted.id);
    expect(ctx.registry.isConnected(host.id)).toBe(true);
    // No `replaced` eviction: the disabled socket was already out of the registry.
    expect(ctx.disconnects).toEqual([`${host.id}:closed`]);
    expect(reconnected.closed).toBeNull();
  });

  it("[TC-PDHOST-013] a close that throws does not fail the request, and still evicts", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const socket = new RecordingSocket();
    socket.closeThrows = true;
    ctx.registry.register(host.id, socket, "token-1");

    const saved = await ctx.hosts.setEnabled(ORG_A, host.id, false);

    // The operator asked for the host to be parked and it is; a socket that was
    // already destroyed is not their problem and must not surface as a 500.
    expect(saved.enabled).toBe(false);
    expect((await ctx.hosts.getById(host.id))?.enabled).toBe(false);
    // Evicted anyway — a socket kept after a failed close would leave the card
    // "connected" forever and let a pane write to a peer that is never reading.
    expect(ctx.registry.isConnected(host.id)).toBe(false);
    expect(ctx.disconnects).toEqual([`${host.id}:closed`]);
  });

  it("[TC-PDHOST-013] disabling an offline host is a no-op", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });

    const saved = await ctx.hosts.setEnabled(ORG_A, host.id, false);

    expect(saved.enabled).toBe(false);
    expect(ctx.disconnects).toEqual([]);
  });
});

describe("[TC-PDHOST-014] deleting a host hangs up on the agent that is still reporting into it", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDHOST-014] closes exactly that host's socket, with a code that is neither replace nor disable", async () => {
    const removed = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const kept = await ctx.hosts.create(ORG_A, { label: "build-02" });
    const foreign = await ctx.hosts.create(ORG_B, { label: "other-org" });
    const removedSocket = new RecordingSocket();
    const keptSocket = new RecordingSocket();
    const foreignSocket = new RecordingSocket();
    ctx.registry.register(removed.id, removedSocket, "token-removed");
    ctx.registry.register(kept.id, keptSocket, "token-kept");
    ctx.registry.register(foreign.id, foreignSocket, "token-foreign");

    expect(await ctx.hosts.remove(ORG_A, removed.id)).toEqual({ id: removed.id, label: "build-01" });

    // The whole point: without this the agent kept sending into a row that no
    // longer existed — every frame updating zero rows, silently, until some later
    // reconnect finally got a 401 nobody was watching for.
    expect(removedSocket.closed?.code).toBe(AGENT_CLOSE_HOST_DELETED);
    expect(removedSocket.closed?.reason).toBe("host deleted");
    // Three different events, three different codes: "the agent dialled again",
    // "an operator parked it", "an operator deleted it". A log that collapses them
    // cannot answer why a machine stopped.
    expect(removedSocket.closed?.code).not.toBe(AGENT_CLOSE_REPLACED);
    expect(removedSocket.closed?.code).not.toBe(AGENT_CLOSE_HOST_DISABLED);
    expect(ctx.registry.isConnected(removed.id)).toBe(false);

    // Nobody else is touched — not the neighbour, not another organization.
    expect(keptSocket.closed).toBeNull();
    expect(foreignSocket.closed).toBeNull();
    expect(ctx.registry.connectedHostIds().sort()).toEqual([kept.id, foreign.id].sort());

    // Exactly one disconnect reaches the terminal relay: the PTYs on that socket
    // are dead and the panes must be told, but only once.
    expect(ctx.disconnects).toEqual([`${removed.id}:closed`]);
  });

  it("[TC-PDHOST-014] the reconnect is refused as 401, not 403 — there is no row left to be disabled", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.tokens.mint(ORG_A, host.id, "laptop");
    const socket = new RecordingSocket();
    ctx.registry.register(host.id, socket, minted.id);

    await ctx.hosts.remove(ORG_A, host.id);

    // The gateway's own precondition, in the order it reads it: `resolve` finds a
    // host id, `getById` finds nothing, and the upgrade is answered `401 invalid
    // agent key`. It cannot say "host deleted" there — the row AND (in Postgres,
    // by `onDelete: CASCADE`) the token row are gone, so there is nothing left to
    // answer from, and inventing a distinct status would hand a spraying client an
    // oracle. That is why the close code above carries the explanation instead:
    // `4004 host deleted` is the only place the machine's journal is ever told why.
    expect(await ctx.hosts.getById(host.id)).toBeNull();
    // Not 403: that is reserved for a host that still exists and is parked, whose
    // agent comes back on one toggle. This one never comes back.
    expect(socket.closed?.code).toBe(AGENT_CLOSE_HOST_DELETED);
  });

  it("[TC-PDHOST-014] a close that throws does not fail the delete, and still evicts", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const socket = new RecordingSocket();
    socket.closeThrows = true;
    ctx.registry.register(host.id, socket, "token-1");

    // The operator asked for the host to be gone and it is; a socket that was
    // already destroyed is not their problem and must not surface as a 500 — which
    // would read as "it is still there" for something that cannot be re-pressed.
    expect(await ctx.hosts.remove(ORG_A, host.id)).toEqual({ id: host.id, label: "build-01" });
    expect(await ctx.hosts.getById(host.id)).toBeNull();
    // Evicted anyway — a socket kept after a failed close would leave a card
    // "connected" for a host that no longer has one.
    expect(ctx.registry.isConnected(host.id)).toBe(false);
    expect(ctx.disconnects).toEqual([`${host.id}:closed`]);
  });

  it("[TC-PDHOST-014] a delete another organization is not allowed to make closes nothing", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const socket = new RecordingSocket();
    ctx.registry.register(host.id, socket, "token-1");

    // Scope is resolved before anything is deleted, so a 404 costs the caller the
    // request and the agent nothing.
    await expect(ctx.hosts.remove(ORG_B, host.id)).rejects.toMatchObject({ code: "HOST_NOT_FOUND" });

    expect(socket.closed).toBeNull();
    expect(ctx.registry.isConnected(host.id)).toBe(true);
    expect(ctx.disconnects).toEqual([]);
    expect(await ctx.hosts.getById(host.id)).not.toBeNull();
  });

  it("[TC-PDHOST-014] deleting an offline host is a no-op", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });

    expect(await ctx.hosts.remove(ORG_A, host.id)).toEqual({ id: host.id, label: "build-01" });

    expect(ctx.disconnects).toEqual([]);
  });
});

describe("[TC-PDAGENT-075] revoking a token drops the connection that credential authenticated", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it("[TC-PDAGENT-075] closes the connection accepted with that token and leaves a sibling token's alone", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const other = await ctx.hosts.create(ORG_A, { label: "build-02" });
    // One host, two live credentials — a spare kept for a rebuild is normal.
    const leaked = await ctx.tokens.mint(ORG_A, host.id, "laptop");
    const inUse = await ctx.tokens.mint(ORG_A, host.id, "spare");
    const otherToken = await ctx.tokens.mint(ORG_A, other.id, "build-02");

    const socket = new RecordingSocket();
    const otherSocket = new RecordingSocket();
    // The agent is connected with the SPARE, not the credential being revoked.
    ctx.registry.register(host.id, socket, inUse.id);
    ctx.registry.register(other.id, otherSocket, otherToken.id);

    await ctx.tokens.revoke(ORG_A, host.id, leaked.id);

    // Closing by host id would have killed this agent for a credential it is not
    // using — the registry remembers which token accepted the socket for exactly
    // this reason.
    expect(socket.closed).toBeNull();
    expect(ctx.registry.isConnected(host.id)).toBe(true);
    expect(ctx.registry.connectedTokenId(host.id)).toBe(inUse.id);
    expect(otherSocket.closed).toBeNull();
    expect(ctx.disconnects).toEqual([]);

    // Now revoke the one it IS using: that connection goes, and only that one.
    await ctx.tokens.revoke(ORG_A, host.id, inUse.id);

    expect(socket.closed?.code).toBe(AGENT_CLOSE_TOKEN_REVOKED);
    expect(socket.closed?.reason).toBe("agent token revoked");
    expect(socket.closed?.code).not.toBe(AGENT_CLOSE_REPLACED);
    expect(ctx.registry.isConnected(host.id)).toBe(false);
    expect(otherSocket.closed).toBeNull();
    expect(ctx.registry.isConnected(other.id)).toBe(true);
    expect(ctx.disconnects).toEqual([`${host.id}:closed`]);
  });

  it("[TC-PDAGENT-075] revoking a token with no live connection is a no-op, and stays idempotent", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const dormant = await ctx.tokens.mint(ORG_A, host.id, "airgap");
    const connected = await ctx.hosts.create(ORG_A, { label: "build-02" });
    const connectedToken = await ctx.tokens.mint(ORG_A, connected.id, "build-02");
    const socket = new RecordingSocket();
    ctx.registry.register(connected.id, socket, connectedToken.id);

    const revoked = await ctx.tokens.revoke(ORG_A, host.id, dormant.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(await ctx.tokens.resolve(dormant.token)).toBeNull();

    // Nothing was connected with it, so nothing was closed — and no other agent
    // was collateral.
    expect(ctx.disconnects).toEqual([]);
    expect(socket.closed).toBeNull();

    // Revoking again is still the first revocation's timestamp, and still harmless.
    const again = await ctx.tokens.revoke(ORG_A, host.id, dormant.id);
    expect(again.revokedAt).toBe(revoked.revokedAt);
    expect(ctx.disconnects).toEqual([]);
  });

  it("[TC-PDAGENT-075] a close that throws does not fail the revocation", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.tokens.mint(ORG_A, host.id, "laptop");
    const socket = new RecordingSocket();
    socket.closeThrows = true;
    ctx.registry.register(host.id, socket, minted.id);

    const revoked = await ctx.tokens.revoke(ORG_A, host.id, minted.id);

    // Revocation is the incident-response lever: it must land even when the socket
    // it is aimed at is already broken.
    expect(revoked.revokedAt).not.toBeNull();
    expect(await ctx.tokens.resolve(minted.token)).toBeNull();
    expect(ctx.registry.isConnected(host.id)).toBe(false);
  });

  it("[TC-PDAGENT-075] rotation is NOT exempt: it revokes, so it hangs up too", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const first = await ctx.tokens.mint(ORG_A, host.id, "laptop");
    const socket = new RecordingSocket();
    ctx.registry.register(host.id, socket, first.id);

    const second = await ctx.tokens.rotate(ORG_A, host.id, first.id);

    // Rotation already broke this agent the moment the old row was revoked — it
    // just would not have found out until some later reconnect. The disconnect
    // moves that outage to the second the operator pressed the button, with the
    // replacement plaintext in the same response. The no-downtime path is
    // mint-new → install → revoke-old (docs/OPERATIONS.md §2-4), which never
    // reaches rotate().
    expect(socket.closed?.code).toBe(AGENT_CLOSE_TOKEN_REVOKED);
    expect(ctx.registry.isConnected(host.id)).toBe(false);
    expect(second.token).not.toBe(first.token);
    expect((await ctx.tokens.resolve(second.token))?.hostId).toBe(host.id);
  });
});
