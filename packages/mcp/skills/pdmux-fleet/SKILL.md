---
name: pdmux-fleet
description: Work with a whole pdmux fleet through an account token — list machines, register one, install its agent over your own ssh, update agents, and delete hosts. Use when the user mentions pdmux and more than one machine, or asks you to add or install a host.
---

# Working with a pdmux fleet

You are on this surface if `pdmux_whoami` answers. It tells you your tier, which
tools you have, which you are missing and what each missing one needs — call it
first and you will not have to guess.

Every tool that names a machine takes a `hostId`. **Call `hosts_list` first and
use an id from it.** Never construct one.

## ⚠ The rule that decides whether you behave correctly

**pdmux never connects to a host and holds no ssh credentials.** The agent dials
out; nothing dials in. When something has to run *on* a machine, these tools hand
you the exact command and **you** run it from your own shell.

Two consequences, and both are easy to get wrong:

- **A host's `address` is operator context only.** It is free-form text that pdmux
  never opens a connection to — it may be a nickname, an old IP, or empty. Do not
  ssh to it because it looks like a hostname. Ask the user where the machine is.
- **You need the user's help to reach a machine.** Ask plainly:

  > I have the install command for `build-01`. How should I reach it — ssh
  > destination and user? Do you have a key configured, or should I prompt for a
  > password? And do you want a system install (needs root/sudo) or a per-user one
  > (`--user`, no root)?

  Do not store what they tell you.

## Adding a machine, end to end

**1. Register it.** `host_create` takes nothing that is required. Call it with no
arguments and it tells you what it needs, so you can ask the user rather than
inventing a label:

```
host_create {}
  → { "pdmux": "needs-input", "needs": [ { "field": "label", … } ] }
host_create { "label": "build-01", "address": "build-01.internal" }
  → the host, plus a single-use install command
```

One call registers the host **and** mints its code. If `enrollment` comes back
`null`, the host still exists and only the code failed — do not treat that as a
failed create. Ask for one with `host_install_command { hostId }`.

**2. Run the one-liner on the target, from your own shell.**

```bash
ssh <destination> 'curl -fsSL <origin>/install.sh | PDMUX_CODE=pdmxe_… sh -s -- --user'
```

For a system install: `… | sudo PDMUX_CODE=pdmxe_… sh`. A bare `sudo sh` drops the
variable and the installer then dies with a usage error that reads like a bug.
Without root and without `--user` it refuses.

`PDMUX_CODE` keeps the code out of the installer's argv and out of the agent's own
environment. It is **still visible in `ps` on the remote** for the life of the ssh
command — that is what single-use and fifteen minutes are for. Do not claim more.

Exit codes: `0` ok · `1` permission · `2` usage · `3` platform or tool missing ·
`4` checksum · `5` enrollment refused · `6` service registration · `7` running but
`doctor` failed.

**3. Verify over MCP.** `host_detail { hostId }` until `online: true` — a few
seconds. **Exit code 0 does not mean connected**: the installer exits before the
agent's first handshake, and reporting success from it is the mistake this step
exists to prevent.

If it does not come online, `host_enrollment_status { hostId }` is the **only**
place the real reason lives. The redeem endpoint answers every failure —
malformed, unknown, expired, already used, revoked — with one identical 401 so that
an attacker learns nothing.

**For several machines, do one at a time.** Create, install, verify, then move on.
A code minted for the twelfth host is dead before you reach it.

## Three failures that look like a broken installer and are not

**A browser-only auth gateway in front of the origin.** An identity-aware proxy
that requires a human login answers a non-browser client with a login page, and the
agent reads that as a failed handshake. Either give `/install.sh`, `/agent/*` and
`/agent/ws` a bypass or service-token policy, or let the host reach pdmux on a
private address. Pass whichever works as `--server`.

The same applies to a CDN with a browser-integrity check enabled: it answers `curl`
with a challenge. The public record for a pdmux origin has to be DNS-only, or
proxied with that check disabled for these paths.

**The installer's origin comes from the request, and the scheme from how the host
was reached.** Behind a proxy, `x-forwarded-proto` is authoritative. Reached
directly on loopback or a private address the scheme is `http`; a public name gives
`https`. Assuming HTTPS bakes an unusable URL into the script, and the very next
thing the script does is download a binary from it — the symptom is
`SSL routines::wrong version number`, after the script itself downloaded fine over
http. Pass `--server` explicitly when the derived answer is wrong.

**A host with no service manager refuses the update path.** The agent runs under
systemd or launchd so it recovers from a crash, a server restart, or a remote
update. Where neither exists, an exit is a hole, and the agent declines to update
itself rather than disappear. That arrives later as `NO_RESTART_SOURCE`.

## Updating an agent

Read `host_detail` first: `agentVersion` against `latestAgentVersion`, and
`agentVersionState`. A machine installed a minute ago is already newest, so an
update would answer `NOT_NEWER`. Say so instead of looping.

`host_agent_update { hostId }` returns that the command was **accepted**, not that
it worked. Only `HOST_OFFLINE`, `AGENT_RELEASE_UNAVAILABLE` and
`AGENT_RELEASE_INVALID` mean it never started. Everything else arrives later on the
host — `VERIFY_FAILED`, `SWAP_FAILED`, `NO_RESTART_SOURCE`, `PROBATION_EXPIRED`,
`ROLLBACK_FAILED` and the rest — and is read with
`host_agent_update_status { hostId }`. Poll it and correlate on `commandId`.

The plain path is safe: the agent proves the new binary can connect **before**
swapping and restores the old one if it cannot. `force` skips the version check,
cannot be undone, and needs an admin token.

Rolling out further is `fleet_agent_update`, which refuses with `NO_CANARY` until
some host already runs the target build. That is not an obstacle to route around —
the single update you just did **is** the canary.

## Anything destructive answers before it acts

Call `host_delete` or `fleet_agent_update` without `confirm: true` and you get a
description of what would be destroyed, plus `retryWith` — the exact arguments for
the confirmed call.

**Show that list to the user in your own words and wait for them to agree.** Then
call again with `retryWith` unchanged. Do not reconstruct the arguments, and do not
treat an earlier instruction as consent: "clean up the test hosts" is not agreement
to twelve deletions.

## What you cannot do, at any tier

Create or revoke a credential — an MCP token, an agent token, anything. There is no
such tool and there will not be one: a credential that could mint credentials turns
one leak into a foothold that revoking the original does not close.

An enrollment code is not an exception. It is single-use, dies in fifteen minutes,
is scoped to one host you already control, and becomes a credential for *a machine*
— not for this surface.
