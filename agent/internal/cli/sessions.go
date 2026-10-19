package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/session"
	"github.com/podosoft-dev/pdmux/agent/internal/term"
	xterm "golang.org/x/term"
)

const sessionHelp = "Usage: pdmux-agent session new|attach|list|terminate|history [name] [--config path] [--root path] [--json]\nDetach: Ctrl+] d. History: Ctrl+] [ / ]. Pan: Ctrl+] arrows. Follow: Ctrl+] f. Literal prefix: Ctrl+] Ctrl+].\n"

func commandSessions(ctx context.Context, argv []string, deps Deps) int {
	action, name, root, configuration := "list", "", "", ""
	jsonOutput := false
	if len(argv) > 0 {
		action = argv[0]
		argv = argv[1:]
	}
	for i := 0; i < len(argv); i++ {
		switch argv[i] {
		case "--json":
			jsonOutput = true
		case "--config", "--root":
			flag := argv[i]
			i++
			if i >= len(argv) {
				fmt.Fprint(deps.Stderr, sessionHelp)
				return exitRefused
			}
			if flag == "--root" {
				root = argv[i]
			} else {
				configuration = argv[i]
			}
		default:
			if name != "" || strings.HasPrefix(argv[i], "-") {
				fmt.Fprint(deps.Stderr, sessionHelp)
				return exitRefused
			}
			name = argv[i]
		}
	}
	configuration = resolve(Args{Config: configuration}, deps).ConfigPath
	client := session.LocalClient(configuration, deps.Executable)
	if root != "" {
		client.Root = root
	}
	if action == "serve" {
		if root == "" {
			return exitRefused
		}
		err := session.Serve(ctx, root, AgentVersion, func(cols, rows int, directory string) (session.Process, error) {
			resolved, err := term.ResolveTarget(protocol.TerminalTarget{Kind: protocol.TerminalShell}, nil)
			if err != nil {
				return nil, err
			}
			return term.Spawn(term.Spec{File: resolved.File, Args: resolved.Args, Cols: cols, Rows: rows, Dir: directory})
		})
		if err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return exitFailed
		}
		return exitOK
	}
	if action == "new" || action == "attach" {
		return attachSession(ctx, client, action, name, deps)
	}
	if action == "stop" {
		_, err := client.Request(ctx, session.Request{Action: "shutdown"})
		if err != nil {
			fmt.Fprintln(deps.Stderr, err)
			return exitFailed
		}
		return exitOK
	}
	if action != "list" && action != "terminate" && action != "history" {
		fmt.Fprint(deps.Stderr, sessionHelp)
		return exitRefused
	}
	reply, err := client.Request(ctx, session.Request{Action: "list"})
	if err != nil && action != "list" {
		fmt.Fprintln(deps.Stderr, err)
		return exitFailed
	}
	if err != nil && err.Error() != "SESSION_ENGINE_NOT_RUNNING" {
		fmt.Fprintln(deps.Stderr, err)
		return exitFailed
	}
	if reply.Sessions == nil {
		reply.Sessions = []session.Info{}
	}
	if action == "list" {
		if jsonOutput {
			_ = json.NewEncoder(deps.Stdout).Encode(reply.Sessions)
		} else {
			for _, item := range reply.Sessions {
				fmt.Fprintf(deps.Stdout, "%s\t%s\t%d attached\n", item.Name, item.ID, item.Attached)
			}
		}
		return exitOK
	}
	id := ""
	for _, item := range reply.Sessions {
		if item.Name == name || item.ID == name {
			id = item.ID
			break
		}
	}
	if id == "" {
		fmt.Fprintln(deps.Stderr, "SESSION_NOT_FOUND")
		return exitFailed
	}
	reply, err = client.Request(ctx, session.Request{Action: action, ID: id})
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return exitFailed
	}
	if jsonOutput {
		_ = json.NewEncoder(deps.Stdout).Encode(reply)
	} else if action == "history" {
		for _, line := range reply.Lines {
			fmt.Fprintln(deps.Stdout, line)
		}
	}
	return exitOK
}

func attachSession(ctx context.Context, client *session.Client, action, name string, deps Deps) int {
	if name == "" {
		fmt.Fprint(deps.Stderr, sessionHelp)
		return exitRefused
	}
	fd := int(os.Stdin.Fd())
	if !xterm.IsTerminal(fd) {
		fmt.Fprintln(deps.Stderr, "A terminal is required for interactive attachment")
		return exitRefused
	}
	cols, rows, err := xterm.GetSize(fd)
	if err != nil {
		return exitFailed
	}
	request := session.Request{Action: "attach", Name: name, Cols: cols, Rows: rows}
	if action == "new" {
		request.Action = "create"
		request.Directory, _ = os.Getwd()
	}
	attachment, err := client.Attach(ctx, request)
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return exitFailed
	}
	defer attachment.Close()
	previous, err := xterm.MakeRaw(fd)
	if err != nil {
		return exitFailed
	}
	defer xterm.Restore(fd, previous)
	defer fmt.Fprint(deps.Stdout, "\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l")
	input := make(chan []byte, 1)
	go func() {
		buffer := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buffer)
			if n > 0 {
				data := append([]byte(nil), buffer[:n]...)
				select {
				case input <- data:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				close(input)
				return
			}
		}
	}()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	prefix := false
	historyNavigation := false
	control := ""
	x, y := 0, 0
	flush := func() {
		end := len(control)
		for end > 0 && !utf8.ValidString(control[:end]) && end > len(control)-4 {
			end--
		}
		if end > 0 {
			_ = attachment.Send(session.Request{Action: "input", Data: control[:end]})
			control = control[end:]
		}
	}
	for {
		select {
		case <-ctx.Done():
			return exitOK
		case <-ticker.C:
			c, r, err := xterm.GetSize(fd)
			if err == nil && (c != cols || r != rows) {
				cols, rows = c, r
				_ = attachment.Send(session.Request{Action: "resize", Cols: c, Rows: r})
			}
		case reply, ok := <-attachment.Replies():
			if !ok {
				return exitFailed
			}
			if reply.Screen != nil {
				x, y = reply.Screen.X, reply.Screen.Y
				if reply.Screen.Follow {
					historyNavigation = false
				}
				if _, err := io.WriteString(deps.Stdout, reply.Screen.Data); err != nil {
					return exitFailed
				}
			}
			if reply.Type == "exit" {
				if reply.Code != nil {
					return *reply.Code
				}
				return exitOK
			}
			if reply.Error != "" {
				return exitFailed
			}
		case data, ok := <-input:
			if !ok {
				return exitOK
			}
			for _, value := range data {
				if prefix {
					if control != "" || value == 27 {
						control += string([]byte{value})
						if len(control) < 3 {
							continue
						}
						switch control {
						case "\x1b[A":
							y--
						case "\x1b[B":
							y++
						case "\x1b[C":
							x++
						case "\x1b[D":
							x--
						}
						if historyNavigation && (control == "\x1b[A" || control == "\x1b[B") {
							delta := 1
							if control == "\x1b[B" {
								delta = -1
							}
							_ = attachment.Send(session.Request{Action: "history", Y: delta})
						} else {
							_ = attachment.Send(session.Request{Action: "viewport", X: max(0, x), Y: max(0, y)})
						}
						prefix = false
						control = ""
						continue
					}
					prefix = false
					switch value {
					case 'd':
						return exitOK
					case '[':
						historyNavigation = true
						_ = attachment.Send(session.Request{Action: "history", Y: max(1, rows-1)})
						continue
					case ']':
						_ = attachment.Send(session.Request{Action: "history", Y: -max(1, rows-1)})
						continue
					case 'f':
						historyNavigation = false
						_ = attachment.Send(session.Request{Action: "viewport", Follow: true})
						continue
					case 29:
						_ = attachment.Send(session.Request{Action: "input", Data: string([]byte{29})})
						continue
					default:
						continue
					}
				}
				if value == 29 {
					flush()
					prefix = true
					continue
				}
				// Send UTF-8 bytes together below; a string containing one byte of a
				// multibyte character would be replaced by JSON encoding.
				control += string([]byte{value})
			}
			if !prefix && control != "" {
				flush()
			}
		}
	}
}
