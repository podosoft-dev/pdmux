package cli

import (
	"fmt"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/config"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
)

// `pdmux-agent doctor` — answer "why is this host not on the dashboard?"
//
// Everything it reports is something that has actually gone wrong during an
// install: a token that resolved from a file nobody expected, a server URL that
// cannot be dialled, no tmux (so sessions look empty), no git (so the repo panel
// stays blank), and how the terminal will get its PTY.
//
// Ported from apps/agent/src/cli/doctor.ts.

// Check is one line of the report.
type Check struct {
	Name   string
	OK     bool
	Detail string
}

// ptyDetail replaces the TypeScript's node-pty/script(1) branch.
//
// The Node agent had to say WHICH implementation it got, because the answer
// changed what worked: without a compiler at install time there was no node-pty,
// and the script(1) impersonation could only resize through /proc — so on macOS a
// resize was silently a no-op. github.com/creack/pty is the syscall itself with
// no cgo, so there is one path, it is always the good one, and the line exists
// only to say so.
const ptyDetail = "native pty (github.com/creack/pty; resize works on Linux and macOS)"

// DoctorInput is everything the report is computed from. The lookups are
// injected so a spec can describe a host without owning one.
type DoctorInput struct {
	Server     string
	Token      string
	ConfigPath string
	Sources    config.Sources
	Warnings   []string
	// WSURL is the normalised endpoint, empty when the server address is unusable.
	WSURL string
	// Which reports whether a binary is on PATH.
	Which func(command string) bool
	// Connect performs the connectivity check; see Probe.
	Connect func(url, token string) ProbeResult
}

// RunDoctor produces the report, in the order it is printed.
func RunDoctor(in DoctorInput) []Check {
	var checks []Check

	configured := in.Server != "" && in.Token != ""
	detail := fmt.Sprintf("server from %s, token from %s (no config file found)",
		sourceOrDefault(in.Sources.Server), sourceOrDefault(in.Sources.Token))
	if in.ConfigPath != "" {
		detail = fmt.Sprintf("server from %s, token from %s (file %s)",
			sourceOrDefault(in.Sources.Server), sourceOrDefault(in.Sources.Token), in.ConfigPath)
	}
	checks = append(checks, Check{Name: "config", OK: configured, Detail: detail})

	for _, warning := range in.Warnings {
		// A file that could not be parsed is its own line rather than a footnote on
		// the config line: it is the single most common reason a host dials
		// nothing, and it has to be impossible to skim past.
		checks = append(checks, Check{Name: "config file", Detail: warning})
	}

	serverDetail := "not configured — pass --server or set " + config.EnvServer
	if in.WSURL != "" {
		serverDetail = in.WSURL
	}
	checks = append(checks, Check{Name: "server url", OK: in.WSURL != "", Detail: serverDetail})

	tokenDetail := "missing"
	if in.Token != "" {
		// The length is the useful part: it is how an operator tells "I pasted the
		// whole key" from "I pasted the first line of it".
		tokenDetail = fmt.Sprintf("%s (%d chars)", log.Redacted, len(in.Token))
	}
	checks = append(checks, Check{Name: "token", OK: in.Token != "", Detail: tokenDetail})

	tmux := in.Which("tmux")
	checks = append(checks, Check{
		Name:   "tmux",
		OK:     tmux,
		Detail: pick(tmux, "found", "missing — sessions will be empty and `session` terminals cannot open"),
	})
	git := in.Which("git")
	checks = append(checks, Check{
		Name:   "git",
		OK:     git,
		Detail: pick(git, "found", "missing — repository snapshots will be skipped"),
	})

	checks = append(checks, Check{Name: "pty", OK: true, Detail: ptyDetail})

	if in.WSURL != "" && in.Token != "" {
		result := in.Connect(in.WSURL, in.Token)
		checks = append(checks, Check{Name: "connectivity", OK: result.OK, Detail: result.Detail})
	} else {
		checks = append(checks, Check{Name: "connectivity", Detail: "skipped — no server or token"})
	}
	return checks
}

// FormatChecks renders the report as the fixed-width table the repro doc quotes.
func FormatChecks(checks []Check) string {
	width := 4
	for _, check := range checks {
		if len(check.Name) > width {
			width = len(check.Name)
		}
	}
	lines := make([]string, 0, len(checks)+2)
	failed := 0
	for _, check := range checks {
		status := "FAIL"
		if check.OK {
			status = "PASS"
		} else {
			failed++
		}
		lines = append(lines, fmt.Sprintf("%s  %-*s  %s", status, width, check.Name, check.Detail))
	}
	if failed == 0 {
		lines = append(lines, "", "All checks passed.")
	} else {
		lines = append(lines, "", fmt.Sprintf("%d check(s) failed.", failed))
	}
	return strings.Join(lines, "\n")
}

func sourceOrDefault(source config.Source) string {
	if source == "" {
		return string(config.SourceDefault)
	}
	return string(source)
}

func pick(condition bool, whenTrue, whenFalse string) string {
	if condition {
		return whenTrue
	}
	return whenFalse
}
