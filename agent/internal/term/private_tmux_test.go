//go:build !windows

package term

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// privateTmux points every tmux this test starts, directly or through Spawn, at
// a server of its own. TMUX is emptied and TMUX_TMPDIR moved so neither the
// test's commands nor an attached client can reach a user's server.
type privateTmux struct {
	root   string
	socket string
	binary string
}

func newPrivateTmux(t *testing.T) *privateTmux {
	t.Helper()
	binary, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux is required for this native test")
	}
	root, err := os.MkdirTemp("/tmp", "pdmux-term-tmux-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Setenv("TMUX", "")
	t.Setenv("TMUX_TMPDIR", root)
	t.Setenv("HOME", root)
	socket := filepath.Join(root, fmt.Sprintf("tmux-%d", os.Getuid()), "default")
	if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
		t.Fatal(err)
	}
	mux := &privateTmux{root: root, socket: socket, binary: binary}
	// Only this private socket is ever named; a server that never started
	// makes this a no-op.
	t.Cleanup(func() { _ = exec.Command(binary, "-S", socket, "kill-server").Run() })
	return mux
}

// run executes one command against the private server and fails the test on error.
func (p *privateTmux) run(t *testing.T, args ...string) string {
	t.Helper()
	output, err := p.try(args...)
	if err != nil {
		t.Fatalf("private tmux %v: %v: %s", args, err, output)
	}
	return output
}

func (p *privateTmux) try(args ...string) (string, error) {
	output, err := exec.Command(p.binary, append([]string{"-S", p.socket}, args...)...).CombinedOutput()
	return strings.TrimSpace(string(output)), err
}
