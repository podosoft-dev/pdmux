# MCP — driving pdmux from an AI CLI

`<origin>/mcp` speaks the Model Context Protocol over Streamable HTTP. This document is
the reasoning behind it: what the two credentials are, what each can reach, and — the
parts most worth writing down — which guarantees changed shape when fleet-wide access
arrived, and what replaced them.

The tool list and the exact arguments live in the tool descriptions themselves, where a
model reads them. This is the part a person needs.

---

## 1. Two credentials, because there are two blast radii

| | host key | account token |
|---|---|---|
| prefix | `pdmux_mcp_` | `pdmux_usr_` |
| issued on | a host's detail page | **Coding CLI access** (`/access`) |
| reaches | that one machine | every host in your scope |
| levels | read / read+write | read / operate / admin |
| expiry | 30–365 days, required | 7–365 days, required |
| a leak costs you | one machine | the fleet |

They are separate tables, and the prefixes are deliberately not extensions of one
another: `pdmux_mcpu_` would have satisfied the older shape check and been looked up in
the wrong table, and a later "fix" for that would have quietly erased the distinction.
Authentication dispatches on the prefix **before any query**, so a presented credential
costs one indexed read and an unrecognised string costs none.

### Neither can create another credential

No tool, in either mode, at any tier, mints a credential. This is the invariant with the
sharpest consequence: a credential that could issue credentials turns one leak into a
foothold that revoking the original does not close.

The enrollment code looks like a counter-example and is not one. It is single-use, dies
in fifteen minutes, is scoped to one host the caller already controls, and redeems into
a credential **for a machine**. An MCP token redeems into this entire surface. Different
objects.

---

## 2. Why the surface is enumerated rather than proxied

The obvious design — the tools call our own REST API over loopback, so permissions live
in exactly one place — needs those routes to accept an MCP credential. They do not:
every fleet route takes a browser session. Teaching them to accept a token as well would
open the *whole* controller surface to it, and the blast radius of a leaked token would
become "whatever a route happens to expose today".

So `packages/mcp/src/gateway.ts` enumerates. Each method is a deliberate grant; the API
implements them by calling the same services the dashboard's own controllers call. What
that gives up is "one place". What it buys is that adding a capability is an edit to an
interface, visible in review, rather than a side effect of somebody adding a route
somewhere else — which is why `POST /hosts/:id/move` and every admin route are out of
reach by default.

That argument is **stronger** since fleet tokens exist, not weaker.

---

## 3. ⚠ What changed shape: `hostId` became a parameter

Host mode had a *structural* guarantee. No tool took a host id, so there was no argument
through which a caller could name another machine, and therefore nothing to validate.
`packages/mcp/test/server-contract.test.ts` asserted exactly that, and still does — for
host mode.

Fleet mode names machines explicitly. The guarantee is now **checked** rather than
structural: every method of `ApiFleetGateway` passes the token's scope into
`HostsService.get(scope, id)` before acting, and a host outside that scope is **404, not
403** — 403 confirms the id exists, which the caller was not entitled to learn.

A guarantee that moves has to take its test with it. That check cannot be asserted in
`packages/mcp`, which has no database, so it lives in
`apps/api/src/mcp/fleet-gateway.spec.ts` beside the call it protects. Read the two files
together; each says so in its own header.

### And what did not change

The old contract test also forbade any tool whose name matched `/register|create/`. That
rule is gone, replaced by the one it actually meant: **no tool mints a credential**,
asserted for every mode and every tier. The concern was never the word — it was a
credential growing its own scope. Creating a host row does not: the row lands inside the
scope the token already had.

---

## 4. Three gates, because a tier is not enough

A token's tier says what it was granted. Three things decide what it can actually do.

1. **At mint time**, `mcpCeilingFor(session)` caps what a person may grant to exactly
   what `assertCanManageFleet` lets them do themselves. Writing that condition out a
   second time is how the two come to disagree, and the disagreement would be a
   privilege-escalation path: an ordinary member of an organization who cannot rename a
   host in the dashboard would otherwise mint a token that can.

2. **At every authentication**, the ceiling is recomputed and the effective tier is
   `min(stored, current)`. A token freezes the scope it was minted in; the person's
   standing in that scope is not frozen with it. Without this, somebody removed from an
   organization keeps fleet-wide access until the token expires — for a year-long token,
   a year.

   ⚠ **Within a bound of a few seconds, not instantly.** The ceiling is cached per
   (user, scope) for `McpAuthorityService.TTL_MS` — the same staleness the app already
   accepts for `require2fa`, and the reason two extra reads do not ride on the highest-
   frequency authenticated surface here. So a demotion lands within that window rather
   than on the next call. Revocation is not affected: that is a row this endpoint reads
   every time, uncached.

   Losing authority **downgrades** rather than revokes. Authority loss is often
   transient (a membership row missing mid-migration, a role being reshuffled), and
   revoking on a transient condition is destructive and unrecoverable on re-promotion. A
   downgraded token simply stops advertising the tools it can no longer use, because
   `tools/list` is rebuilt per request from the effective tier — the clearest signal a
   model can get. The screen shows it as `Reduced to Read`.

3. **At every call**, the scope filter of §3.

`MCP_TIER_INSUFFICIENT` and `MCP_FLEET_ADMIN_REQUIRED` are different codes on purpose:
the first is fixed by minting a stronger token, the second by a person gaining authority
they do not have.

---

## 5. Destructive tools describe before they act

A tool requires `confirm: true` when its effect **cannot be undone by calling this same
surface again**.

⚠ **This table applies to BOTH modes.** Host mode registered `host_install_command`
for every key and gated nothing until 2026-08-03 — so a read-only key could retire a
live code, and nothing was written to the audit trail. Fleet mode had it right; host
mode now matches, and host-mode mutations are audited against the key (`actorId` is
null, because a host key belongs to a machine's connection and not to a person).

| tool | gated | why |
|---|---|---|
| `host_delete` | always | cascades tokens, keys, services and history; the machine is refused until re-enrolled |
| `fleet_agent_update` | always | N machines each replace their binary and exit, and there is no downgrade tool |
| `host_agent_update` | only with `force` | the plain path is one machine and the agent restores itself if the new binary cannot connect |
| `host_install_command` | only when a code is live | minting retires the previous code, voiding an install somebody is part-way through. It also needs **write** (`operate`) in both modes: the code it returns is redeemable for an agent token that outlives the credential that minted it |
| `host_update` | no | reversible by calling again, including `enabled: false` |
| `run_command` | no | arbitrary, so it cannot be pre-classified — and a confirmation on every call is a rubber stamp the model learns to pass |

Called without `confirm`, a gated tool returns a plan and `isError: **false**` — it is
not a failure, it is the answer to "what would happen", and an error makes a model retry
differently or abandon the task. The plan carries `retryWith`: the **verbatim** arguments
for the confirmed call, so the model reconstructs nothing and cannot confirm something
other than what it showed the person.

⚠ **The dry run is a separate, read-only gateway method** (`deleteHostPlan`, not
`deleteHost(dryRun)`). That is what makes "a dry run cannot mutate" assertable against a
recording fake; with one method behind a flag there is nothing to assert and a later
refactor folding them together would pass every test.

---

## 6. Why there is no "ask the user" primitive

MCP has elicitation, and the installed SDK supports it. This endpoint cannot use it.

`/mcp` is stateless on purpose — a server and transport are built per request
(`sessionIdGenerator: undefined`), so there is no session store to grow or expire, a
restart loses nothing, and a second replica needs no coordination. GET is answered 405
for the same reason. Elicitation is a server→client **request**, and delivering one needs
the client's GET stream to exist.

Making the endpoint stateful to enable a prompt the calling AI can produce itself is a
bad trade, so tools that need more information **return** it:

```json
{ "pdmux": "needs-input", "tool": "host_create",
  "needs": [ { "field": "label", "required": true, "why": "…", "example": "build-01" } ],
  "hint": "Ask the user in your own conversation and call again." }
```

`host_create` therefore declares **no required properties**. That is not laziness: a
missing zod-required property produces `InvalidParams`, a transport-level error — which
is exactly what this package's own rule forbids ("failures are RETURNED, not thrown, so a
model can correct the call itself").

---

## 7. Installing an agent: where pdmux stops

pdmux never connects to a host. There is no ssh client, no remote-exec library, no
process spawner, and the only channel to a machine is a WebSocket that machine opened —
`sendToHost` returns "offline" rather than dialling. A host's `address` is operator
context only; it is free-form text with no validation, and an AI must not ssh to it
without asking.

So the loop, per machine, is:

1. `host_create` — registers the host *and* mints its code in one response.
   If `enrollment` comes back `null` the host still exists; ask for a code with
   `host_install_command`. That is deliberate — the host is the durable thing.
2. The AI runs the one-liner **on the target, from its own shell**, asking the user for
   the ssh destination and how to authenticate. `PDMUX_CODE=…` in the environment keeps
   the code out of the installer's argv and out of the agent's environment; it is still
   visible in `ps` on the remote for the life of the ssh command, which is what
   single-use and fifteen minutes are for.
3. `host_detail` until `online: true`. **The installer exits before the first
   handshake**, so exit code 0 does not mean connected.

For several machines, one at a time: a code minted for the twelfth host is dead before
you reach it.

⚠ **`host_enrollment_status` is the only place the real reason lives.** `POST
/agent/enroll` answers every failure — malformed, unknown, expired, consumed, revoked —
with an identical `ENROLL_CODE_INVALID` 401, so that an attacker learns nothing. The
operator-side view is where they are told apart.

---

## 8. Accepted is not succeeded

`host_agent_update` returns that the **command was accepted**. Only three failures are
synchronous, and they mean it never started:

`HOST_OFFLINE` · `AGENT_RELEASE_UNAVAILABLE` · `AGENT_RELEASE_INVALID` · (fleet only)
`NO_CANARY`

Everything else arrives later, on the host, and is read with
`host_agent_update_status`: `NOT_NEWER`, `SHA_MISMATCH`, `SIZE_MISMATCH`,
`ARCH_MISMATCH`, `BUSY`, `EXE_NOT_WRITABLE`, `NO_RESTART_SOURCE`, `RATE_LIMITED`,
`BAD_ARTIFACT_PATH`, `REDIRECT_REFUSED`, `DOWNLOAD_FAILED`, `VERIFY_FAILED`,
`SWAP_FAILED`, `STATE_UNWRITABLE`, `PROBATION_EXPIRED`, `PROBATION_ATTEMPTS`,
`SWAP_INCOMPLETE`, `ROLLBACK_FAILED`. Poll and correlate on `commandId`.

`NO_CANARY` is not an obstacle to route around: a fleet-wide push of a build nobody has
run is the one action here with no natural limit on the damage, so update one host first.
That single update *is* the canary.

Installer exit codes, for step 2 above: `0` ok · `1` permission · `2` usage · `3`
platform or tool missing · `4` checksum · `5` enrollment refused · `6` service
registration · `7` running but `doctor` failed.

---

## 9. Turning it off

Two switches, because there are two questions.

- **`mcpEnabled`** (Admin ▸ Settings) — is this *server* an MCP server? Global, ships
  **on**, because host keys already exist and an upgrade must not silently stop them.
  Checked before the credential is read, so a disabled endpoint answers everyone
  identically, and answered **404** — a 401 would tell a client to retry with a better
  key for ever. It fails **open** on a read error: a database blip must not read as
  every CLI in the fleet being broken.
- **`mcpUserTokens`** (fleet Settings) — does *this fleet* accept fleet-wide
  credentials? Per scope, ships **off**, for the reason `staleHostRetentionDays` already
  wrote down: a capability with a much larger blast radius must not arrive switched on
  in fleets nobody consulted. Host keys are unaffected either way.

⚠ Turning either off **revokes nothing**. Tokens stop working immediately and work again
when it is turned back on.

---

## 10. What is recorded

Every **mutating** tool call writes an audit entry: the tool, the target, and
`{ via: "mcp", tokenId, tier, effectiveTier, confirmed }` — `confirmed` is what separates
"a person agreed" from "a token did it". The dry-run branch is recorded too, because
"somebody's agent tried to delete a host" is the line an operator most wants.

Reads are **not** audited. A model polling `host_detail` every two seconds during an
install would bury the mutations the table exists for; `lastUsedAt` on the credential
already answers "was this used".

`run_command`'s arguments are not recorded — only the binary and how many arguments there
were. A command line is the likeliest place on this surface for a secret, and an audit
table that records secrets is a second place they leak from.
