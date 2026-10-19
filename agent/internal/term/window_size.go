package term

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// The attach chain (ResolveTarget) sets `window-size largest` on the user's own
// tmux window. These helpers record what the window had before and put it back
// after the last pdmux viewer of the session leaves. The record lives on the
// window as a user option, so an agent restart in between still restores the
// user's value instead of `largest`.
const (
	windowSizeMarker = "@pdmux-window-size"
	// inheritedWindowSize records that the window had no local window-size.
	inheritedWindowSize = "inherit"
	tmuxPolicyTimeoutMs = 2000
)

// windowSizes are the values tmux accepts; anything else in a marker restores
// to inheriting.
var windowSizes = []string{"largest", "smallest", "manual", "latest"}

var windowIDPattern = regexp.MustCompile(`^@[0-9]+$`)

// tmuxRunner runs one tmux command line and returns its standard output.
type tmuxRunner func(args ...string) (string, error)

// hostTmux runs the tmux a session terminal attaches with, in the environment
// its client gets, so both reach the same server.
func hostTmux(args ...string) (string, error) {
	result := sys.Run(context.Background(), sys.ResolveBinary(muxBinary, ""), args,
		sys.Options{TimeoutMs: tmuxPolicyTimeoutMs, Env: spawnEnv()})
	if result.NotFound || result.TimedOut || result.Code != 0 {
		return "", fmt.Errorf("tmux %s failed (code %d)", args[0], result.Code)
	}
	return result.Stdout, nil
}

// saveWindowSize records the session's current window's own window-size in the
// marker unless an earlier viewer already did. Failure only means there is
// nothing to restore later: the session does not exist yet (the attach chain
// marks a window it creates), or tmux predates window-size (2.9).
func saveWindowSize(run tmuxRunner, session string) {
	target := "=" + session + ":"
	out, err := run("show-options", "-gwv", "window-size", ";", "show-options", "-w", "-t", target)
	if err != nil {
		return
	}
	prior := inheritedWindowSize
	// The first line is the global value; the rest are the window's own options.
	for _, line := range strings.Split(out, "\n")[1:] {
		switch name, value, _ := strings.Cut(strings.TrimSpace(line), " "); name {
		case windowSizeMarker:
			return
		case "window-size":
			prior = value
		}
	}
	_, _ = run("set-option", "-w", "-t", target, windowSizeMarker, prior)
}

// restoreWindowSize puts back every marked window of the session and removes
// the marker. Windows are found by marker rather than by the current window
// because the user may have switched windows since the attach.
func restoreWindowSize(run tmuxRunner, session string) {
	out, err := run("list-windows", "-t", "="+session, "-F", "#{window_id} #{"+windowSizeMarker+"}")
	if err != nil {
		return
	}
	for _, line := range strings.Split(out, "\n") {
		id, saved, _ := strings.Cut(strings.TrimSpace(line), " ")
		if saved == "" || !windowIDPattern.MatchString(id) {
			continue
		}
		restore := []string{"set-option", "-w", "-u", "-t", id, "window-size"}
		if slices.Contains(windowSizes, saved) {
			restore = []string{"set-option", "-w", "-t", id, "window-size", saved}
		}
		_, _ = run(append(restore, ";", "set-option", "-w", "-u", "-t", id, windowSizeMarker)...)
	}
}
