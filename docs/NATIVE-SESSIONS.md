# Native persistent terminal sessions

The agent includes a local terminal engine for macOS, Linux and Windows. Creating a
native session needs no tmux, WSL, language runtime or additional installation.
Existing tmux sessions remain available through the separate tmux adapter.

## Persistence and isolation

The network agent starts a detached helper from an immutable copy of its own
executable. The helper owns the PTYs (ConPTY on Windows); the network agent, browser,
desktop and command-line clients are disposable viewers. Closing a panel or quitting
the desktop disconnects that viewer. Network-agent restarts, server deployments and
replacement of the installed agent binary leave the helper and its programs running.

Only explicit session termination, a program's own exit, OS shutdown or helper failure
ends a native session. This is process persistence, not checkpointing: programs cannot
be restored after the computer reboots or the helper crashes. A missing UUID produces
an error; reattachment never silently substitutes a new empty shell.

Each agent configuration path selects a separate engine under its state directory.
The IPC endpoint requires a random local secret. Unix directories are owner-only,
sockets and metadata are private, and Windows uses a named-pipe ACL restricted to the
current user and SYSTEM. No server token is passed to the helper. An empty engine
exits after one minute; an engine with running sessions remains alive without viewers.
Linux service units need `KillMode=process`, as they already do for agent-created
tmux servers. Existing units with `KillMode=control-group` need the same correction.

## Existing tmux sessions

Native and tmux sessions have independent namespaces. Both may be called `main`.
Targets identify their backend, and native targets additionally carry a UUID. The
picker distinguishes PDMux and tmux entries even when their names match. Saved legacy
layouts without a backend continue to use tmux; they are not converted automatically.

Creating, resizing, detaching or terminating a native session never invokes tmux or
changes its socket, options or processes. Attaching to an existing tmux entry uses the
existing adapter and preserves its program. The adapter's existing per-window largest
size policy still applies only to tmux windows attached through PDMux. Native terminal
creation does not require the tmux adapter to be installed or available.

## Several viewers, one application

There is one PTY and one application screen per session. Its columns and rows are the
largest requested dimensions among attached viewers; after the last viewer leaves,
the previous size remains. Each viewer receives its own viewport with the original
font size and a cursor-following policy. The terminal menu provides manual movement
and a return to cursor following. A small viewer does not shrink the larger viewer
and does not receive tmux's unused-area filler. A single application cannot have
independently reflowed TUI layouts for every viewer at once.

The helper parses VT output, answers terminal queries once, and sends rendered rows
and cursor state. Raw application control sequences are not broadcast to every
viewer. Input modes such as bracketed paste, cursor keys and mouse tracking are
preserved; mouse coordinates include the viewer's viewport offset. Slow viewers have
bounded queues and receive a fresh snapshot. A congested browser transport reconnects
for a complete snapshot instead of dropping arbitrary screen changes.

Main-screen history is bounded by 5,000 lines and an estimated 8 MiB of cell storage.
Alternate-screen applications expose their current screen; their private transcript
remains the application's responsibility. The engine allows at most 16 programs and
64 simultaneous viewers. Input and snapshot queues have explicit limits. Image
protocols and arbitrary OSC side effects are not forwarded.

## Scrolling, colors and selection

The browser's rendering buffer is separate from the application's buffer. A wheel
at a normal shell scrolls the engine's history, without sending arrow keys to the
shell. A fullscreen program that enables mouse tracking receives the wheel itself;
its private transcript is not part of the engine's history. Shift+wheel reaches
main-screen history. Touch gestures and the scroll buttons use the same wheel path.
History stays still while new output arrives. Typing or choosing cursor following
returns to live output.

Drag to select shell text. Hold Shift (or Option on macOS) to select the visible
screen of a mouse-capturing program, then use the usual copy shortcut. Selection
copies on release. Multiline paste preserves the application's bracketed-paste
mode. Application OSC clipboard side effects are not forwarded.

Wheel input carries its origin separately from keyboard input. On return from a
fullscreen program, momentum is cancelled and mouse/focus reports are accepted
only while their corresponding input modes remain enabled. This prevents delayed
scroll or focus reports from appearing as escape characters at the shell prompt;
ordinary keyboard arrows and literal pasted text remain intact.

On a phone, the output/history sheet provides selectable plain text and a copy
button without requiring a desktop selection modifier. A fullscreen program's
private transcript still belongs to that program. Device emulation verifies
routing and layout; native selection handles, the clipboard permission prompt,
the software keyboard and paste menus require checks on the physical browser.

Desktop terminals advertise `TERM=xterm-256color`, `COLORTERM=truecolor` and
`TERM_PROGRAM=PDMux`. Color-disable flags inherited from the process that launched
the desktop are removed before starting its embedded agent. Choices set inside a
shell still apply to that shell's programs. Indexed colors and truecolor attributes
are retained in snapshots and history.

Native views enable xterm's Unicode 11 width provider so common emoji occupy the
same two columns as the engine, including when a program paints a different
background immediately after them. Legacy tmux views keep their existing width
provider.

A running helper retains its own executable and environment across desktop updates.
Engine changes apply when that helper is restarted after its programs have exited;
updates never kill those programs to replace the helper.

## Interactive CLI over SSH

Run these commands as the same OS user as the agent. The normal agent configuration
lookup selects the same engine as `run`; use `--config` to choose another instance.
Desktop-specific engine roots can be selected explicitly with `--root`.

```sh
pdmux-agent session new work
pdmux-agent session list --json
pdmux-agent session attach work
pdmux-agent session history work
pdmux-agent session terminate work
pdmux-agent session list --config /path/to/agent.json
```

In an attached terminal, `Ctrl+] d` detaches, `Ctrl+] [` / `Ctrl+] ]` page through history,
`Ctrl+]` followed by an arrow moves the viewport, and `Ctrl+] f` resumes cursor
following. Press `Ctrl+]` twice to send a literal prefix to the application.
Names or UUIDs select sessions for history and termination; interactive attachment
uses the listed name. Native CLI commands manage native sessions only. Existing tmux
sessions keep their usual `tmux attach` command as well as the PDMux picker entry.

## Compatibility

The agent advertises `terminal.nativeSessions` and `terminal.screenProtocol` in
`hello`. A supporting server returns `terminalScreenProtocol: 1` in `welcome`.
These are additive protocol fields with legacy defaults. An older agent is offered
its existing tmux/shell paths. Native targets are refused explicitly when the agent
does not support them; they never fall back to a same-name tmux session. An existing
local engine with an incompatible IPC protocol is reported rather than killed.
