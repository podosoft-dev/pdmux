//go:build !windows

package term

import (
	"strings"
	"testing"
	"time"
)

// agentControl is how an installed or desktop-embedded agent is configured.
// The token is the host's credential; none of these describe the user's shell.
var agentControl = map[string]string{
	"PDMUX_CONFIG":        "/etc/pdmux/agent.json",
	"PDMUX_SERVER":        "https://pdmux.invalid",
	"PDMUX_TOKEN":         "pdmux-host-secret",
	"PDMUX_HOSTNAME":      "leak-probe",
	"PDMUX_LOG_LEVEL":     "debug",
	"PDMUX_STATE_DIR":     "/var/lib/pdmux-probe",
	"PDMUX_RESTART":       "none",
	"PDMUX_GIT_BIN":       "/usr/bin/git",
	"PDMUX_DESKTOP_AGENT": "1",
}

func setAgentControl(t *testing.T) {
	t.Helper()
	for name, value := range agentControl {
		t.Setenv(name, value)
	}
	// Shares the prefix but belongs to the user, so it must survive.
	t.Setenv("PDMUX_USER_NOTE", "kept")
}

// leakedControl lists the agent control variables present in env-style lines.
func leakedControl(lines []string) []string {
	var leaked []string
	for _, line := range lines {
		name, _, found := strings.Cut(strings.TrimSpace(line), "=")
		if _, control := agentControl[name]; found && control {
			leaked = append(leaked, name)
		}
	}
	return leaked
}

func TestTerminalOmitsAgentControlEnv(t *testing.T) {
	t.Run("[TC-PDTERM-152] a shell terminal does not inherit the agent's control variables", func(t *testing.T) {
		setAgentControl(t)
		t.Setenv("HOME", t.TempDir())
		resolved, err := ResolveTarget(shellTarget(), env(map[string]string{"SHELL": shellPath(t)}))
		if err != nil {
			t.Fatal(err)
		}
		process, err := Spawn(Spec{File: resolved.File, Args: resolved.Args, Cols: 200, Rows: 50})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			process.Kill()
			select {
			case <-process.Exit():
			case <-time.After(ptyTimeout):
				t.Error("shell did not stop")
			}
		})
		output := record(process)
		// The quotes keep the typed echo from matching the shell's own output.
		if err := process.Write("env | sed 's/^/ENV:/'; echo 'ENV_''DONE'\n"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, ptyTimeout, "the shell's environment", func() bool { return strings.Contains(output.text(), "ENV_DONE") })

		// Cut, not CutPrefix: the first line can follow a prompt printed late.
		var entries []string
		for _, line := range strings.Split(output.text(), "\n") {
			if _, entry, ok := strings.Cut(strings.TrimRight(line, "\r"), "ENV:"); ok {
				entries = append(entries, entry)
			}
		}
		if leaked := leakedControl(entries); len(leaked) > 0 {
			t.Fatalf("the shell inherited agent control variables: %v", leaked)
		}
		for _, kept := range []string{"PDMUX_USER_NOTE=kept", "TERM=xterm-256color"} {
			if !containsLine(entries, kept) {
				t.Fatalf("the shell lost %s; got %v", kept, entries)
			}
		}
	})

	t.Run("[TC-PDTERM-152] a tmux server started for a session does not keep them", func(t *testing.T) {
		mux := newPrivateTmux(t)
		setAgentControl(t)
		name := "leakprobe"
		resolved, err := ResolveTarget(sessionTarget(&name), nil)
		if err != nil {
			t.Fatal(err)
		}
		process, err := Spawn(Spec{File: resolved.File, Args: resolved.Args, Cols: 80, Rows: 24, Dir: mux.root})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			process.Kill()
			select {
			case <-process.Exit():
			case <-time.After(ptyTimeout):
				t.Error("tmux client did not stop")
			}
		})
		record(process)
		waitFor(t, ptyTimeout, "the private session", func() bool {
			_, err := mux.try("has-session", "-t", "="+name)
			return err == nil
		})
		// The server's global environment is what every later session and pane
		// starts from, so a value here outlives this terminal.
		global := strings.Split(mux.run(t, "show-environment", "-g"), "\n")
		if leaked := leakedControl(global); len(leaked) > 0 {
			t.Fatalf("the tmux server kept agent control variables: %v", leaked)
		}
		if !containsLine(global, "PDMUX_USER_NOTE=kept") {
			t.Fatalf("the tmux server lost the user's variable; got %v", global)
		}
	})
}

func containsLine(lines []string, want string) bool {
	for _, line := range lines {
		if strings.TrimSpace(line) == want {
			return true
		}
	}
	return false
}
