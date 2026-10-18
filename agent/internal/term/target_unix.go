//go:build !windows

package term

import "strings"

// fallbackShell is used when $SHELL is unset or not an absolute path. A
// relative value would be resolved against PATH, which is not what a login
// shell should ever be picked by.
const fallbackShell = "/bin/bash"

func resolveShell(getenv func(string) string) Resolved {
	shell := getenv("SHELL")
	if !strings.HasPrefix(shell, "/") {
		shell = fallbackShell
	}
	return Resolved{File: shell, Args: []string{"-l"}, Label: "shell"}
}
