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
be restored after the computer reboots or the helper crashes. Within one boot, a
missing UUID produces an error; reattachment never substitutes a new empty shell.
After a confirmed reboot a saved pane reopens a new shell under the same identity and
says so — see "After the host restarts".

Each agent configuration path selects a separate engine under its state directory.
The IPC endpoint requires a random local secret. Unix directories are owner-only,
sockets and metadata are private, and Windows uses a named-pipe ACL restricted to the
current user and SYSTEM. No server token is passed to the helper. An empty engine
exits after one minute; an engine with running sessions remains alive without viewers.
Linux service units need `KillMode=process`, as they already do for agent-created
tmux servers. Existing units with `KillMode=control-group` need the same correction.

## After the host restarts

A reboot ends every program, so a saved layout would otherwise come back as a grid of
dead panes. The helper therefore keeps `restore.json` in its state directory (owner-only,
replaced atomically, not tied to the helper's secret) with the UUID, name, working
directory and size of each live session and the boot it was recorded in. The boot is
Linux `/proc/sys/kernel/random/boot_id` or macOS `kern.bootsessionuuid`; where neither
is available, restore is off. On Linux the working directory is refreshed from
`/proc/<pid>/cwd` every 30 seconds; elsewhere it stays the directory the shell started in.

- A session that exits by itself, or that a person terminates, is removed from the
  record. Only sessions that were alive when the machine went down can come back.
- An attach for a UUID the helper does not have succeeds only when the record holds it
  from an **earlier** boot. The helper then starts a new shell with the same UUID and
  name in the recorded directory (or the home directory when it is gone), once, however
  many panes ask at the same time. In the same boot the attach fails as before.
- A saved tmux pane carries its tmux id and name. When the tmux server is gone, or the
  id now names a different session, the agent does not start tmux: it opens a native
  session of that name instead (attaching one that already exists). A live id with its
  own name attaches tmux as before; a pane opened by name only still uses `new -A`.
- Either way the ready frame carries `restored: { reason: "reboot" }`, the pane shows a
  one-line notice that the session was reopened and that earlier programs were not
  restored, and the layout saves the pane as the native session from then on.

The previous programs, their output and their scrollback are not recovered. The notice
is what keeps a fresh shell under an old name from being mistaken for the old session.
A tmux session renamed outside PDMux is no longer followed by id: the same id after a
restart is a different session, so a saved pane only matches its id together with the
name it was saved with. Renames made through PDMux update the saved panes, in every
window: the API records each tmux rename it makes and lists the earlier names on the
live session (`previousNames`), and a pane follows the new name only when its id matches
and its saved name is one of them. The window then reconnects and reloads under the new
name. A record lasts while the host reports that id under the new name (or the old one,
until the heartbeat that shows the rename arrives). It is dropped when the session ends,
when it is renamed outside PDMux, or when the agent reconnects. Records are kept in the
API's memory and shared between replicas through the event bus. After an API restart a
window that still holds the old name reopens it as a native session, as before.

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

Application window titles (OSC 0/1/2) are discarded before screen emulation;
the pane header uses session identity and personal display metadata instead.
Title filtering tracks UTF-8 characters across output chunks so a continuation
byte cannot terminate a title early and print its suffix in a coding client's
input row. Other output, including colors, hyperlinks and terminal queries,
continues to the emulator.

A running helper retains its own executable and environment across desktop updates.
The updated agent compares its version with the helper before opening a terminal. An
older helper with no sessions is stopped through its atomic idle-only shutdown operation,
and a helper from the installed agent is started automatically. Concurrent agent/CLI
opens share a startup lock; equal or newer helpers are reused. A busy helper stays alive,
so engine parser and rendering changes take effect after its programs have exited.
Updates never kill those programs to replace the helper.

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

## Personal pane names and tags

Choose **More pane actions → Name and tags** to add an optional display name and
up to six tags, each with a name and color. The device and original session name
remain visible. Clear the display name or remove tags to restore the original
header. Names support Unicode and spaces; display names are limited to 64
characters and tag names to 32.

This metadata belongs to the user's saved layout, on the local SQLite runtime or
the connected server. It follows the pane when moved and survives reloads. A
detached window carries a snapshot in its URL; edits there apply to that window.
Display edits never rename a native UUID or a legacy tmux session and never
restart the program or reconnect its terminal.

## Compatibility

The agent advertises `terminal.nativeSessions` and `terminal.screenProtocol` in
`hello`. A supporting server returns `terminalScreenProtocol: 1` in `welcome`.
These are additive protocol fields with legacy defaults. An older agent is offered
its existing tmux/shell paths. Native targets are refused explicitly when the agent
does not support them; they never fall back to a same-name tmux session. An existing
local engine with an incompatible IPC protocol is reported rather than killed.


## Rename and manage sessions

The pane menu offers **Rename session** for the current persistent terminal. The
profile menu and pane menu also open **Manage sessions**, a searchable, paginated
list across all accessible hosts. The list includes sessions without an open pane,
identifies the engine and attached viewer count, and disables changes for offline
hosts. Select a row to rename it or end it. Ending requires confirmation showing
the host and session name; it stops the programs running in that session.

A real session name is shared by everyone viewing the host. It differs from the
personal **Display name and tags** saved in a user's layout. Each tag has a name,
background color and optional text color. **Auto text** restores a contrasting black
or white foreground that follows the background. Existing tags keep automatic contrast;
custom colors persist across reloads and detached windows. Renaming preserves
those personal fields, the PTY, its history and attached viewers. Names accept
1–32 ASCII letters, digits, underscores or hyphens. Duplicate names are rejected
within the selected engine; native and tmux sessions remain independent.

Native control addresses the session UUID. The additive `renameSessions` terminal
ability prevents requests to an older agent. An updated agent can rename sessions on an
older, protocol-compatible helper even when that helper lacks the rename operation.
It stores shared names by UUID in an owner-only, generation-scoped local catalog.
The updated CLI, host session list and new attachments resolve those names consistently;
renames survive network-agent restarts. Name collisions are serialized across clients,
and a freed name can create a distinct session without selecting the renamed program.
The helper keeps its original PTYs, history and viewers. Replacing the helper itself
still waits until its programs exit; renaming never forces that replacement. An
incompatible IPC protocol remains an explicit error.

Legacy tmux sessions report `tmuxId` (`$` followed by digits). Rename, termination,
attachment and reconnect use this ID within the running tmux server rather than a
mutable name. Old layouts learn IDs from the host's session list; ready frames also
pin the server and browser relays to an acknowledged ID. Renaming does not send keys
to the program or create a replacement session. Older agents without IDs require an
agent update before these management operations are available. tmux IDs, as documented
in the [tmux manual](https://man.openbsd.org/tmux), belong to the lifetime of that tmux server.

The authenticated HTTP endpoints are:

- `POST /terminal/:hostId/sessions/rename`: `{ backend: "native", sessionId, name }`
  or `{ backend: "tmux", tmuxId, name }`.
- `POST /terminal/:hostId/sessions/terminate`: the same engine and identity, without
  `name`. The optional `session` field preserves compatibility with existing clients.

Both operations authorize the current host scope, use the ordinary desktop bridge
when the host belongs to another backend, record an audit event, and refresh the
shared host list through the heartbeat path. No database migration is required.
