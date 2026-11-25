package session_test

import (
	"runtime"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/podosoft-dev/pdmux/agent/internal/session"
	"github.com/podosoft-dev/pdmux/agent/internal/term"
)

func TestNativeReflowShell(t *testing.T) {
	t.Run("[TC-PDTERM-187] a real program's long line survives narrowing and widening the pane", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			// ConPTY repaints its own screen after a resize; the emulator tests
			// cover the rewrap on every platform.
			t.Skip("the program below is POSIX sh")
		}
		// A plain sh, not the user's shell: it prints the line and becomes cat.
		// An interactive shell can drop typeahead while it starts, and redraws
		// its prompt on SIGWINCH from where it thinks the prompt was, which can
		// erase rows above it in any terminal that rewraps. That is the shell,
		// not the engine. The command line is not echoed, and does not contain
		// the line it prints anyway.
		program := func(cols, rows int, directory string) (session.Process, error) {
			return term.Spawn(term.Spec{File: "/bin/sh", Args: []string{"-c", "X=0123456789; printf 'A%s%s%s%s%s%s%sZ\\n' $X $X $X $X $X $X $X; exec cat"}, Cols: cols, Rows: rows, Dir: directory})
		}
		engine := session.NewEngine(program)
		defer engine.Close()
		view, info, err := engine.Open(session.Request{Action: "create", Name: "reflow", Cols: 40, Rows: 8})
		if err != nil {
			t.Fatal(err)
		}
		defer view.Close()
		long := "A" + strings.Repeat("0123456789", 7) + "Z"
		count := func() int {
			lines, _, _ := engine.History(info.ID)
			n := 0
			for _, line := range lines {
				if strings.Contains(ansi.Strip(line), long) {
					n++
				}
			}
			return n
		}
		eventually(t, func() bool { return count() == 1 })
		for _, cols := range []int{20, 80, 33, 40} {
			if err := view.Apply(session.Request{Action: "resize", Cols: cols, Rows: 8}); err != nil {
				t.Fatal(err)
			}
			if n := count(); n != 1 {
				t.Fatalf("after resizing to %d columns the line appears %d times", cols, n)
			}
		}
	})
}
