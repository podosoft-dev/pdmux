/**
 * The non-registering dial, and the budget that keeps it cheap.
 *
 * WHY IT EXISTS AT ALL: a remote update proves the candidate binary can connect
 * BEFORE it commits the swap — the running agent execs `<candidate> verify` and
 * waits for a real `welcome`. Dialling normally would be self-defeating: the
 * gateway keeps one socket per host and `AgentRegistryService.register` closes
 * the previous one with code 4000, which invalidates every PTY that host has
 * open. The candidate's proof would therefore cause exactly the outage the
 * verify-then-commit design exists to avoid, during an update that may then be
 * refused anyway.
 *
 * WHAT THE FLAG BUYS, PRECISELY: the connection is authenticated exactly as a
 * normal one (same token, same disabled-host rule) and is answered with the same
 * `welcome` — so it proves the same things — but it is not registered, not
 * tracked, not swept, and leaves no trace on the host row. The agent's own
 * `Probe` never sends `hello`, so there is nothing to write even if we wanted to;
 * skipping `applyHello` is belt and braces against a future candidate that does.
 *
 * ⚠ THE FLAG IS CLIENT-CONTROLLED. Anything a caller can turn off by adding a
 * query parameter must not be a security control. That is why the *credential*
 * side of a dial (resolving the token, refusing a revoked one, stamping
 * `lastUsedAt`) is deliberately identical in both modes, and only the
 * *fleet-state* side (registry, host row, ack ledger) is skipped.
 */

/** Query key carrying the mode. Mirrors `update.VerifyModeParam` in the agent. */
export const VERIFY_MODE_PARAM = "mode";
/** The one value that selects it. Mirrors `update.VerifyMode` in the agent. */
export const VERIFY_MODE_VALUE = "verify";

/**
 * Is this upgrade asking for the non-registering mode?
 *
 * Exact match, never a prefix or a case-fold: an unrecognised value must fall
 * through to a normal connection, because a typo that silently produced a
 * non-registering socket would look like an agent that connects and then never
 * appears — the hardest failure on this path to diagnose.
 */
export function isVerifyDial(query: URLSearchParams): boolean {
  return query.get(VERIFY_MODE_PARAM) === VERIFY_MODE_VALUE;
}

/** A verify dial costs a token resolution plus a config build (two queries). */
export const VERIFY_DIALS_PER_WINDOW = 6;
export const VERIFY_WINDOW_MS = 10 * 60_000;

/**
 * How many verify dials one host may make in a window.
 *
 * WHY IT NEEDS ITS OWN LIMITER: the global HTTP rate limiter does not cover a
 * WebSocket upgrade, which is handled by the native upgrade callback. Nothing else
 * on this path counts anything.
 *
 * WHY A LIMIT IS WARRANTED HERE AND NOT ON A NORMAL DIAL: a normal connection is
 * self-limiting, because the agent holds it open and its own reconnect backs
 * off. A verify dial is one shot and hangs up, so a host looping on a failing
 * update would make the server resolve a token and build a config as fast as it
 * can spawn processes. Six per ten minutes is far above the real ceiling — the
 * agent's updater allows three attempts per thirty minutes — and far below the
 * rate at which a loop would matter.
 *
 * KEYED BY HOST, NOT BY ADDRESS: the address is whatever the last proxy hop put
 * in a header, and several hosts legitimately share one NAT. The host id is
 * established by the token, so the budget is spent by the party that actually
 * owns it.
 */
export class VerifyDialBudget {
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly limit: number = VERIFY_DIALS_PER_WINDOW,
    private readonly windowMs: number = VERIFY_WINDOW_MS,
  ) {}

  /** Records the dial and says whether it is within budget. */
  allow(hostId: string, now: number): boolean {
    const since = now - this.windowMs;
    // Pruning every host (not just this one) on each call keeps the map bounded
    // by the number of hosts that dialled recently rather than by the number of
    // host ids ever seen — this object lives as long as the process.
    for (const [key, stamps] of this.recent) {
      const live = stamps.filter((stamp) => stamp > since);
      if (live.length === 0) this.recent.delete(key);
      else this.recent.set(key, live);
    }
    const stamps = this.recent.get(hostId) ?? [];
    if (stamps.length >= this.limit) return false;
    stamps.push(now);
    this.recent.set(hostId, stamps);
    return true;
  }
}
