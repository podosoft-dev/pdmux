---
name: pdmux-onboard
description: First-time setup for a pdmux host — connect this machine's CLI to the hosted MCP and get its agent installed. Use when someone hands you a pdmux endpoint and key, or says a host is not connected yet.
---

# Getting connected to pdmux

## What you were given

A host label, an endpoint ending in `/mcp`, and the NAME of an environment
variable holding a key. You should never have been given the key's value; if you
were, say so and ask for it to be revoked.

## Check the connection first

Call `host_detail`. If it answers, the MCP connection works and the key is valid.

If it does not:

- **401** — the variable is not reaching the MCP process, or the key was revoked
  or has expired. Check the variable is set in the environment your CLI runs in;
  do not print its value to check.
- **403** — the request carried an `Origin` that does not match the endpoint.
  That is a browser-shaped request; a CLI should not be sending one.

## Then get the agent on the machine

`host_detail` says `online: false` until an agent is installed and connected.

Call `host_install_command` and hand the returned line to the person at that
machine. It is single-use and short-lived. Add `--user` if they want it under
their own account with no root — it registers a per-user service either way.

Poll `host_detail` until `online: true`. Then you can read metrics, sessions,
repositories and usage, and — if the key has write access — run commands.

## What you cannot do from here

**With a host key** (`pdmux_mcp_…`): create a host. That key is bound to one
machine and no tool takes a host id, so there is nothing to try. If you need to
register machines, the person needs to give you an account token instead — see
`pdmux-fleet`.

**With either credential**: create or revoke another credential. There is no such
tool at any level, and there will not be one — a credential that could mint
credentials turns one leak into a foothold that revoking the original does not
close.
