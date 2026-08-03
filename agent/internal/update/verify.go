package update

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

// VerifyMode is the query parameter that asks the server for a NON-REGISTERING
// connection, and it is the load-bearing detail of Gate 1.
//
// ⚠ WITHOUT IT, VERIFYING WOULD CAUSE THE OUTAGE IT PREVENTS. The server keeps
// one socket per host and the newer connection wins: `registry.register` closes
// the previous one with code 4000 ("replaced by a newer connection"), which
// tears down every PTY that host has open. A candidate binary dialling normally
// would therefore kill the live agent's terminals — during an update whose whole
// purpose is to avoid exactly that — and then hang up, leaving the host briefly
// unregistered.
//
// WHAT THE SERVER MUST DO WITH IT (this is the ask, not an implementation):
// authenticate the key exactly as it does today, send `welcome`, and then do
// none of the stateful things — no registry.register/unregister, no host-row or
// version write, no "host is online" side effect. Closing the socket after the
// welcome is fine and expected; the candidate hangs up as soon as it has one.
// The upgrade handler already parses the query (`upgradeQuery`) and already
// strips it before matching the path (`upgradePath`), so the branch is small.
//
// UNTIL THE SERVER HAS IT, an agent built from this package still verifies —
// against a server that ignores the parameter, the candidate's dial registers,
// and the live agent's sockets are replaced. That is why the parameter lives in
// the URL the engine hands the candidate rather than anywhere in the candidate
// itself: the engine's behaviour is testable without the server, and the server
// side ships as its own change.
const VerifyMode = "verify"

// VerifyModeParam is the query key carrying VerifyMode.
const VerifyModeParam = "mode"

// VerifyURL adds the non-registering mode to the agent's own endpoint.
func VerifyURL(serverURL string) (string, error) {
	if serverURL == "" {
		return "", fmt.Errorf("the agent has no server endpoint to verify against")
	}
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return "", fmt.Errorf("unusable server address %q: %w", serverURL, err)
	}
	query := parsed.Query()
	query.Set(VerifyModeParam, VerifyMode)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

// execVerify is the default Gate 1: run the CANDIDATE's own `verify` subcommand.
//
// WHY THE CANDIDATE RUNS IT AND NOT US: the entire class being caught is "this
// build cannot connect". Anything the running agent does proves something about
// the RUNNING build. Only executing the new file proves the new file can be
// executed at all (architecture, dynamic loader, missing libc), can parse this
// host's config, can build a TLS session against this server's certificate
// chain, and is accepted by this server's protocol-version gate. `verify` exits
// 0 only after a real `welcome`, which is the same bar the daemon has to clear.
//
// WHY IT IS GIVEN THIS HOST'S OWN CONFIG: a regressed config parser is a real
// regression class, and it only shows up against the file that is actually
// installed here.
func execVerify(ctx context.Context, candidate string, spec VerifySpec) error {
	args := []string{"verify", "--server", spec.URL}
	if spec.ConfigPath != "" {
		args = append(args, "--config", spec.ConfigPath)
	}
	command := exec.CommandContext(ctx, candidate, args...)
	// The token goes in the ENVIRONMENT, never in argv: argv is readable by every
	// account on the box through /proc and `ps`, while a process environment is
	// not. The flag would have been shorter and that is not a reason.
	command.Env = append(os.Environ(), "PDMUX_TOKEN="+spec.Token)
	output, err := command.CombinedOutput()
	if err == nil {
		return nil
	}
	detail := strings.TrimSpace(string(output))
	if detail == "" {
		detail = err.Error()
	}
	// The candidate's own words are carried through: `closed before welcome (code
	// 4401 invalid agent key)` is the difference between an operator fixing a
	// token and an operator reinstalling an agent.
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return fmt.Errorf("the new binary failed its connection check (exit %d): %s",
			exitErr.ExitCode(), firstLine(detail))
	}
	if ctx.Err() != nil {
		return fmt.Errorf("the new binary did not finish its connection check in time")
	}
	return fmt.Errorf("the new binary could not be run: %s", firstLine(detail))
}

// firstLine keeps the report inside the contract's 512-character message cap and
// puts the useful sentence first — `verify` writes one line on failure.
func firstLine(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		text = text[:index]
	}
	return clamp(strings.TrimSpace(text), 300)
}
