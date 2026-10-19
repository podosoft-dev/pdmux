package term

import (
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
)

// fakeTmux records tmux command lines and answers them from a script, so the
// window-size policy can be checked without a tmux server.
type fakeTmux struct {
	mu     sync.Mutex
	calls  []string
	answer func(line string) (string, error)
}

func (f *fakeTmux) run(args ...string) (string, error) {
	line := strings.Join(args, " ")
	f.mu.Lock()
	f.calls = append(f.calls, line)
	f.mu.Unlock()
	if f.answer == nil {
		return "", nil
	}
	return f.answer(line)
}

func (f *fakeTmux) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeTmux) count(prefix string) int {
	n := 0
	for _, call := range f.recorded() {
		if strings.HasPrefix(call, prefix) {
			n++
		}
	}
	return n
}

const showMain = "show-options -gwv window-size ; show-options -w -t =main:"

func TestWindowSizePolicy(t *testing.T) {
	save := func(t *testing.T, out string, err error) []string {
		t.Helper()
		tmux := &fakeTmux{answer: func(string) (string, error) { return out, err }}
		saveWindowSize(tmux.run, "main")
		return tmux.recorded()
	}
	expect := func(t *testing.T, got []string, want ...string) {
		t.Helper()
		if !slices.Equal(got, want) {
			t.Fatalf("tmux calls\n got %q\nwant %q", got, want)
		}
	}

	t.Run("[TC-PDTERM-023] records an inherited window-size before the first attach", func(t *testing.T) {
		expect(t, save(t, "latest\n@unrelated value\n", nil), showMain, "set-option -w -t =main: @pdmux-window-size inherit")
	})

	t.Run("[TC-PDTERM-023] records the window's own window-size", func(t *testing.T) {
		expect(t, save(t, "latest\nmonitor-activity on\nwindow-size smallest\n", nil), showMain, "set-option -w -t =main: @pdmux-window-size smallest")
	})

	t.Run("[TC-PDTERM-023] keeps a value an earlier viewer or agent recorded", func(t *testing.T) {
		expect(t, save(t, "latest\n@pdmux-window-size smallest\nwindow-size largest\n", nil), showMain)
	})

	t.Run("[TC-PDTERM-023] records nothing without the session or the option", func(t *testing.T) {
		expect(t, save(t, "", errors.New("no such window")), showMain)
	})

	t.Run("[TC-PDTERM-023] restores every marked window and removes the marker", func(t *testing.T) {
		tmux := &fakeTmux{answer: func(line string) (string, error) {
			if strings.HasPrefix(line, "list-windows") {
				return "@1 inherit\n@2 \n@3 smallest\n@4 bogus\nnot-an-id smallest\n", nil
			}
			return "", nil
		}}
		restoreWindowSize(tmux.run, "main")
		expect(t, tmux.recorded(),
			"list-windows -t =main -F #{window_id} #{@pdmux-window-size}",
			"set-option -w -u -t @1 window-size ; set-option -w -u -t @1 @pdmux-window-size",
			"set-option -w -t @3 window-size smallest ; set-option -w -u -t @3 @pdmux-window-size",
			"set-option -w -u -t @4 window-size ; set-option -w -u -t @4 @pdmux-window-size",
		)
	})

	t.Run("[TC-PDTERM-023] restores nothing when the session is gone", func(t *testing.T) {
		tmux := &fakeTmux{answer: func(string) (string, error) { return "", errors.New("can't find session") }}
		restoreWindowSize(tmux.run, "main")
		expect(t, tmux.recorded(), "list-windows -t =main -F #{window_id} #{@pdmux-window-size}")
	})
}
