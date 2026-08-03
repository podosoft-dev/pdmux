// Package sys runs child processes, always bounded.
//
// WHY EVERY CALL IS BOUNDED: the collector runs on someone's working machine. A
// wedged `tmux`, or a repository on a stalled NFS mount, must cost this pass its own
// result and never the whole loop — so a timeout is a required argument rather than an
// option, and a missing binary is an ordinary result rather than an error to handle.
//
// This is a port of apps/agent/src/sys/exec.ts and keeps its shape on purpose: the
// callers were written against these four flags (code / notFound / timedOut / output),
// and every collector decides what to do from them rather than from an error string.
package sys

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"time"
)

// DefaultMaxOutput caps what one command may hand back. A runaway producer must not
// grow the agent's heap — the agent lives on a machine somebody else is working on.
const DefaultMaxOutput = 32 << 20 // 32 MiB

// Result is everything a caller needs to decide, without inspecting an error type.
type Result struct {
	// Code is the exit status, or -1 when the process was killed or never started.
	Code   int
	Stdout string
	Stderr string
	// NotFound reports that the binary is not installed. Callers read this as
	// "this host does not have git/tmux", which is a fact to report, not a failure.
	NotFound bool
	TimedOut bool
}

// Options mirrors the TypeScript signature. TimeoutMs has no default on purpose:
// picking one here is how an unbounded call sneaks in.
type Options struct {
	TimeoutMs int
	Dir       string
	// Env replaces the environment when non-nil. Nil inherits the agent's own, which
	// is what every current caller wants.
	Env []string
	// MaxOutput overrides DefaultMaxOutput. Zero means the default.
	MaxOutput int
}

// cappedBuffer stops writing once it holds Limit bytes. It never returns an error for
// the overflow: a truncated `git log` is a usable answer, while a failed one is not,
// and the caller's own caps (DIFF_CAPS and friends) are what make truncation visible.
type cappedBuffer struct {
	buf   bytes.Buffer
	Limit int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	room := c.Limit - c.buf.Len()
	if room <= 0 {
		return len(p), nil
	}
	if len(p) > room {
		c.buf.Write(p[:room])
		return len(p), nil
	}
	c.buf.Write(p)
	return len(p), nil
}

// Run executes file with args and never returns an error for the process's own
// behaviour — only the Result says what happened.
//
// SIGKILL, not SIGTERM, on timeout: the reason a command is being killed here is that
// it stopped responding, and a process ignoring the clock has no reason to honour a
// polite signal. The TypeScript used `killSignal: 'SIGKILL'` for the same reason.
func Run(ctx context.Context, file string, args []string, options Options) Result {
	limit := options.MaxOutput
	if limit <= 0 {
		limit = DefaultMaxOutput
	}

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(options.TimeoutMs)*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(runCtx, file, args...)
	cmd.Dir = options.Dir
	cmd.Env = options.Env
	cmd.WaitDelay = time.Second
	// exec.CommandContext sends os.Kill by default; state it so a future edit that
	// switches to SIGTERM has to argue with this comment first.
	cmd.Cancel = func() error { return cmd.Process.Kill() }

	stdout := &cappedBuffer{Limit: limit}
	stderr := &cappedBuffer{Limit: limit}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err := cmd.Run()
	result := Result{Code: 0, Stdout: stdout.buf.String(), Stderr: stderr.buf.String()}
	if err == nil {
		return result
	}

	// The deadline is checked before the error is classified: a killed process reports
	// "signal: killed", which is indistinguishable from a real SIGKILL without it.
	result.TimedOut = errors.Is(runCtx.Err(), context.DeadlineExceeded)
	result.Code = -1

	var exitErr *exec.ExitError
	switch {
	case errors.Is(err, exec.ErrNotFound):
		result.NotFound = true
	case errors.As(err, &exitErr):
		result.Code = exitErr.ExitCode() // -1 when killed by a signal, which is correct here
	}
	// A PATH lookup failure surfaces at Run() rather than Command() in Go; catch the
	// wrapped form too so `notFound` stays as reliable as ENOENT was in Node.
	var pathErr *exec.Error
	if errors.As(err, &pathErr) && errors.Is(pathErr.Err, exec.ErrNotFound) {
		result.NotFound = true
	}
	return result
}

// Which reports whether a binary is on PATH. Callers use it for the diagnostics that
// tell an operator *why* a card is missing sessions or repositories, so "absent" has
// to be an answer rather than an error.
func Which(name string) (string, bool) {
	// ⚠ NOT `exec.LookPath` ALONE. Under a service manager PATH is a handful of
	// system directories, so a tool the operator installed for themselves reads as
	// absent — and `doctor` then reports "missing" for something sitting right
	// there. ResolveBinary looks where a login shell would.
	resolved := ResolveBinary(name, "")
	if !isExecutableFile(resolved) {
		return "", false
	}
	return resolved, true
}
