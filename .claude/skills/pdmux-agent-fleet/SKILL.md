---
name: pdmux-agent-fleet
description: Use when installing, enrolling, or verifying pdmux host agents — one machine or many. Covers creating a host and its one-time enrollment code, running the installer over SSH, confirming the agent connected, and diagnosing the failures that look like a broken installer but are not.
---

# Install pdmux agents across a fleet

The agent is one static Go binary. A target machine needs **outbound HTTPS** and
`curl` (or `wget`) plus `sha256sum` (or `shasum`/`openssl`). No language runtime, no
compiler, no inbound port, no VPN, no SSH key distribution, and no git — git is a
prerequisite for the repository feature, not for the install.

## Tools

The `pdmux-fleet` MCP server (`tools/fleet-mcp.mjs`, wired in `.mcp.json`) does the
two steps that need an authenticated call, so the loop below is something you can
actually run rather than a dozen dashboard visits:

| Tool | What it does |
| --- | --- |
| `list_hosts` | The fleet, and whether each host is online. Read-only. |
| `host_detail` | One host, with its services and capabilities. Read-only. |
| `register_host` | Registers a host and returns the install command with its one-time code. |
| `issue_enrollment` | A fresh code for an existing host; discards the previous one. |
| `enrollment_status` | Whether a live enrollment exists and what the last attempt did. Never the code. |

It needs `PDMUX_ORIGIN`, `PDMUX_EMAIL` and `PDMUX_PASSWORD` in the environment, and it
deliberately does **not** run the installer — that means SSH, and SSH credentials
belong in the operator's own shell. The tools hand back the command to run.

## The loop, per machine

1. **Create the host** with `register_host`. It registers the host and hands back a
   live enrollment code in the same response — there is no separate "issue a code"
   step.
2. **Run the installer** on the target:
   ```bash
   curl -fsSL <origin>/install.sh | sh -s -- --code pdmxe_XXXXX-XXXXX-XXXXX-XXXXX
   ```
   The code is **single-use and expires in fifteen minutes**. Expired or mistyped:
   `issue_enrollment` mints a new one and discards the old in the same call.
3. **Verify it connected** with `list_hosts` — the host appears online and reports
   its capabilities. Do not report success from the installer's exit status alone; it
   exits before the agent has finished its first handshake.

For many machines, do this per machine rather than in one loop that fans out: each
code is single-use and short-lived, so generating them all up front means the later
ones expire before they are used. Create, install, verify, then move on.

## Before touching a fleet

- **Never run destructive host actions against a machine somebody uses.** Deleting a
  host takes its tokens with it and the machine is refused until it is re-registered.
  Test with a throwaway host.
- **Say which machines you are about to act on and wait for confirmation** when the
  list came from anywhere other than the user's explicit instruction.

## Three failures that look like a broken installer and are not

**A browser-only auth gateway in front of the origin.** An identity-aware proxy that
requires a human login answers a non-browser client with a login page, and the agent
reads that as a failed handshake. Either give `/install.sh`, `/agent/*` and
`/agent/ws` a bypass or service-token policy, or let the host reach pdmux on a
private address. Pass whichever works as `--server`.

The same applies to a CDN with a browser-integrity check enabled: it answers `curl`
with a challenge. The public record for a pdmux origin has to be DNS-only, or
proxied with that check disabled for these paths.

**The installer's origin comes from the request, and the scheme from how the host was
reached.** Behind a proxy, `x-forwarded-proto` is authoritative. Reached directly on
loopback or a private address, the scheme is `http`; a public name gives `https`.
Assuming HTTPS bakes an unusable URL into the script, and the very next thing the
script does is download a binary from it — the symptom is
`SSL routines::wrong version number`, after the script itself downloaded fine over
http. Pass `--server` explicitly when the derived answer is wrong.

**A host with no service manager refuses the update path.** The agent runs under
systemd or launchd so it recovers from a crash, a server restart, or a remote
update. Where neither exists, an exit is a hole, and the agent declines to update
itself rather than disappear.

## Air-gapped machines

Copy the binary across and install it directly:

```bash
pdmux-agent install --server <origin> --token <token>
```

## What never goes in a log

The enrollment code and the long-lived token. The code is visible in `ps` for the
moment the one-liner runs, which is exactly why it is single-use, high-entropy and
short-lived; that design is void if either value starts appearing in scrollback, a
unit file, argv, or a commit. The token's only path is the HTTPS response, the agent
process, and its own `0600` config file.
