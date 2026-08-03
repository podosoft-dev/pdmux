---
name: pdmux-operate
description: Work with a pdmux host through its hosted MCP — read its state, install its agent, and run commands on it. Use when the user mentions pdmux, a registered host, or asks about a machine's CPU/disk/sessions/repos.
---

# Working with a pdmux host

pdmux is a dashboard for machines. Your key is bound to **one** host, so every
tool here acts on that host and none of them takes a host id. If you need another
machine, you need another key.

## Before anything else

Call `host_detail`. It answers three questions at once: which machine this is,
whether its agent is connected, and what that agent can do.

- `online: false` → the machine has no agent yet. Go to **Installing the agent**.
- `online: true` but `capabilities` has no `exec` → the agent is too old to run
  commands. `run_command` will refuse with `HOST_EXEC_UNSUPPORTED`. Updating it is
  a dashboard action, or an `operate` account token — see `pdmux-fleet`.

## If your credential is an account token instead

A token minted on **Coding CLI access** reaches every host in the fleet, and its
tools all take a `hostId`. You are on that surface if `pdmux_whoami` answers; call
`hosts_list` before anything that names a machine. Read `pdmux-fleet` — the rules
there are different, and one of them decides whether you behave correctly.

## Installing the agent

1. `host_install_command` mints a fresh single-use code and returns the finished
   one-liner.
2. **You do not run it.** It has to run on the target machine, and that means a
   shell there — which belongs to the person at it. Show them the command.
3. The code is single-use and expires in fifteen minutes. If it lapses, call the
   tool again; minting retires the previous code, so there is never more than one
   live.
4. `host_detail` flips to `online: true` within a few seconds of a successful
   install.

## Running commands

`run_command` takes the binary and its arguments **separately**:

```
command: "git", args: ["status", "--porcelain"]
```

There is no shell. `;`, `&&`, `|`, `$(…)` and globs are literal characters in an
argument — they will not do what they look like. If you genuinely need a shell,
ask for it explicitly: `command: "sh", args: ["-c", "…"]`, and be aware that you
have then taken responsibility for quoting.

Read the answer properly:

- `exitCode` is the verdict. `-1` means the process was killed or never started.
- `timedOut: true` means *we* stopped it — that is not the same as it failing.
- `code: "COMMAND_NOT_FOUND"` means the binary is not installed on that host.
- `truncated: true` means output was cut at 64 KiB; narrow the command rather
  than asking again.

A read-only key refuses this tool with `MCP_KEY_READ_ONLY`. That is a decision
somebody made when they minted it — do not work around it.

## Reading state

`host_metrics` (CPU/memory/disk history), `host_sessions` (terminal multiplexer
sessions), `host_services` (registered ports and their probe status),
`host_usage` (which coding CLIs run there and how much budget is left),
`host_repos` (git checkouts, ahead/behind, dirty counts).

Prefer these over shelling out. They are already collected, they cost the host
nothing, and they work on a read-only key.

## The key

It lives in an environment variable your MCP configuration points at. Never
print it, never write it into a file, never put it in a commit. If it leaks, the
fix is to revoke it in the host's **Agent connection** settings and mint another.
