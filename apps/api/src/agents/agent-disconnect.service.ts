import { ProductLogger } from "../logging/product-logger";
import {
  AGENT_CLOSE_HOST_DELETED,
  AGENT_CLOSE_HOST_DISABLED,
  AGENT_CLOSE_TOKEN_REVOKED,
} from "@pdmux/protocol";
import { HostsService } from "../hosts/hosts.service";
import { AgentRegistryService } from "./agent-registry.service";

/**
 * Makes an authorization change act on the connection it was checked for.
 *
 * WHY THIS EXISTS: the gateway authenticates ONCE, at the WebSocket upgrade, and
 * nothing re-checked that decision afterwards. So the two levers an operator has
 * both stopped at the *next* connection, which for a healthy agent may be days
 * away:
 *
 *   - Disabling a host refused its next upgrade with a 403 while the live socket
 *     kept heartbeating and its card kept updating. Someone who parks a machine to
 *     stop it reasonably believes it stopped.
 *   - Revoking a token is the incident-response lever — "this credential is
 *     compromised" — and it only stopped a reconnect that had not happened yet.
 *   - Deleting a host took the row and its tokens, and left the agent talking into
 *     the hole: every frame updated zero rows, silently, so an operator saw the
 *     host gone while the machine went on reporting to a server that no longer had
 *     anywhere to put it.
 *
 * WHY IT IS ITS OWN SERVICE: `AgentConfigPushService` next door delivers settings
 * to a connection; this ends one. Sharing a class would put "keep talking to it"
 * and "stop talking to it" behind one name. The seam is the same, deliberately:
 * the listener is registered from the agents side at startup so `hosts` never has
 * to know this module exists (no `forwardRef`).
 *
 * WHY THE CLOSE CODES DIFFER FROM `4000`: a replaced socket is routine (the same
 * agent dialled again); these three are a person acting. A log that cannot tell
 * them apart turns "an operator revoked this" into "the network flapped".
 *
 * ⚠ NOTHING HERE THROWS. Every entry point is reached from a mutation that already
 * committed, so a socket that is mid-close must not turn a completed write into a
 * 500 — the same rule the config push follows.
 */
export class AgentDisconnectService {
  private readonly logger = new ProductLogger(AgentDisconnectService.name);

  constructor(
    private readonly hosts: HostsService,
    private readonly registry: AgentRegistryService,
  ) {}

  connect(): void {
    this.hosts.setEnabledChangeListener((hostId, enabled) => this.applyEnabled(hostId, enabled));
    this.hosts.setRemovedListener((hostId) => this.applyRemoved(hostId));
  }

  /**
   * A host was enabled or disabled.
   *
   * Enabling does nothing on purpose: the agent is already retrying on its own
   * backoff and the next upgrade now passes, so re-enabling costs the operator the
   * toggle and nothing else — no reinstall, no token, no restart on the machine.
   */
  applyEnabled(hostId: string, enabled: boolean): void {
    if (enabled) return;
    if (this.registry.closeHost(hostId, AGENT_CLOSE_HOST_DISABLED, "host disabled")) {
      this.logger.log(`Disconnected agent host=${hostId}: the host was disabled`);
    }
  }

  /**
   * A host was deleted — the agent has nowhere left to report, so stop pretending.
   *
   * WHY IT IS NOT `4002`: disabling and deleting look identical from the socket's
   * end and could not be less alike from the machine's. A disabled host is parked —
   * its tokens are untouched and one toggle brings the same agent back. A deleted
   * host is gone, its tokens went with the row (`onDelete: CASCADE`), and the agent
   * still installed on that machine will be refused every time it dials from now
   * on. `4004 host deleted` is the only place that difference is ever said out
   * loud: the reconnect can only answer `401 invalid agent key`, because there is
   * no longer a row or a token to answer from.
   *
   * The recovery is therefore a REGISTRATION, not a toggle — register the host
   * again and enroll the agent on that machine (`docs/OPERATIONS.md` §2-5).
   */
  applyRemoved(hostId: string): void {
    if (this.registry.closeHost(hostId, AGENT_CLOSE_HOST_DELETED, "host deleted")) {
      this.logger.log(`Disconnected agent host=${hostId}: the host was deleted`);
    }
  }

  /**
   * A credential was revoked — drop the connection IT authenticated, and only that
   * one.
   *
   * A host may hold several valid tokens (a spare kept for a rebuild, one per
   * operator). Closing by host id would drop an agent that is using a token nobody
   * revoked, which is why the registry remembers the `tokenId` each socket was
   * accepted with.
   *
   * A token with no live connection is a no-op — the common case, since most
   * revocations retire a credential that is not in use.
   */
  applyTokenRevoked(tokenId: string): void {
    const closed = this.registry.closeForToken(tokenId, AGENT_CLOSE_TOKEN_REVOKED, "agent token revoked");
    for (const hostId of closed) {
      this.logger.log(`Disconnected agent host=${hostId}: its token was revoked`);
    }
  }
}
