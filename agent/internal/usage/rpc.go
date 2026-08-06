package usage

// Provider #2 — ask the CLI itself over its JSON-RPC app-server protocol.
//
// WHY NOT THE SESSION LOGS: the first version of this integration parsed rate
// limits out of the CLI's rollout JSONL files. That format died in a later
// release (state moved into sqlite and no rollout files are written at all), so
// the card served a nine-day-old sample while the account was nearly spent. The
// app-server protocol is what the CLI's own TUI calls, so it cannot rot without
// the CLI itself noticing.
//
// Flow: spawn `<bin> app-server`, write `initialize`, then
// `account/rateLimits/read`, read stdout until the matching id answers. Anything
// else on that stream (notifications, log lines) is ignored.
//
// Ported from apps/agent/src/usage/rpc-cli.ts.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// rpcRequestID is the id of the question we care about; `initialize` takes 1.
const rpcRequestID = 2

// defaultRPCTimeoutMs bounds one read. It is generous because the CLI may have to
// reach its own backend, and the TTL in CachedCollector is what keeps that cost
// off the heartbeat.
const defaultRPCTimeoutMs = 20_000

// maxTranscriptBytes caps what one CLI may hand back. The agent lives on a
// machine somebody else is working on: a chatty (or wedged) app server must not
// grow its heap. The answer is a few hundred bytes.
const maxTranscriptBytes = 1 << 20

// Backoff after an ask that yielded nothing.
//
// ⚠ AN EMPTY ANSWER THAT COSTS A SPAWN MUST NOT BE RE-BOUGHT EVERY PASS. On a
// host where the CLI is installed but idle — no live session, nothing for the
// transcript reader either — this provider is consulted every collection, and
// each consultation is the launcher plus its ~259 MB native binary. Measured on
// two 15 GB hosts that were already paging: the spawn ran at the 60 s cadence
// all night, each one stretching that heartbeat to 2.1–9.7 s (74 and 52 slow-pass
// warnings in 16 h), and its working set fed the very memory pressure that was
// making the machines feel slow. The answer it kept buying was "nothing".
//
// So an empty answer starts a hold-off, and consecutive empties double it up to
// the cap. A non-empty answer clears it: while the CLI is actually in use the
// question keeps being asked at the collector's own cadence, which is the cost
// the fallback was always allowed to have. The state is in-memory on purpose —
// an agent restart retrying immediately is correct, not a leak.
const (
	rpcEmptyBackoffInitialSec = 10 * 60
	rpcEmptyBackoffCapSec     = 30 * 60
)

type rpcClientInfo struct {
	Name    string `json:"name"`
	Title   string `json:"title"`
	Version string `json:"version"`
}

type rpcInitializeParams struct {
	ClientInfo rpcClientInfo `json:"clientInfo"`
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

// RequestPayload is what goes in on stdin: the handshake the protocol requires,
// then our question, one JSON object per line.
func RequestPayload() string {
	initialize, _ := json.Marshal(rpcRequest{
		JSONRPC: "2.0", ID: 1, Method: "initialize",
		Params: rpcInitializeParams{ClientInfo: rpcClientInfo{
			Name: "pdmux-agent", Title: "pdmux agent", Version: "1.0",
		}},
	})
	read, _ := json.Marshal(rpcRequest{
		JSONRPC: "2.0", ID: rpcRequestID, Method: "account/rateLimits/read",
		Params: struct{}{},
	})
	return string(initialize) + "\n" + string(read) + "\n"
}

// rateLimitsNotification is how a current CLI volunteers the limits.
//
// ⚠ THE REQUEST/RESPONSE METHOD IS BACK — AND IT WAS PROBABLY NEVER THE PROBLEM.
// This comment used to say `account/rateLimits/read` had gone away in codex 0.145,
// because it was answered by nothing. Measured again against 0.146 it answers in
// full, and the reason the earlier reading looked like a removed method is the bug
// fixed below: the agent closed stdin immediately after writing, and the app server
// reads EOF as "we are done" and drops the request. Same symptom, different cause,
// and the wrong conclusion cost the notification path being treated as the only one.
//
// Both shapes are still accepted, which is what makes that mistake survivable.
//
// Both shapes are accepted. An older CLI that still answers the request keeps working; a
// current one is heard when it speaks.
const rateLimitsNotification = "account/rateLimits/updated"

// ExtractRPCResult pulls the limits out of a stdio JSON-RPC transcript.
//
// found is false while nothing has arrived yet — distinct from a nil result with found
// true, which is an answer saying "no limits". Collapsing the two would make a CLI that
// answers "nothing to report" indistinguishable from one that never answered, and the
// reader stops as soon as it is answered.
func ExtractRPCResult(stdout string) (any, bool) {
	for _, line := range strings.Split(stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		// A partially received last line lands here too; it simply fails to parse
		// and is read again once the rest of it arrives.
		if !strings.HasPrefix(trimmed, "{") {
			continue
		}
		var message map[string]any
		if err := json.Unmarshal([]byte(trimmed), &message); err != nil {
			// Not JSON — a log line on the same stream. Keep reading.
			continue
		}
		if id, ok := message["id"].(float64); ok && int(id) == rpcRequestID {
			return message["result"], true
		}
		if method, _ := message["method"].(string); method == rateLimitsNotification {
			// The notification carries the limits where a result would have carried them;
			// `WindowsFromRPCResult` looks for `rateLimits` inside either.
			return message["params"], true
		}
	}
	return nil, false
}

// WindowsFromRPCResult turns an `account/rateLimits/read` result into raw
// windows, keyed BY DURATION.
//
// ⚠ `primary`/`secondary` is not a window identity: a measured account carried
// the weekly window in `primary` with `secondary` null.
func WindowsFromRPCResult(result any) []RawWindow {
	out := []RawWindow{}
	object, ok := result.(map[string]any)
	if !ok {
		return out
	}
	limits, ok := object["rateLimits"].(map[string]any)
	if !ok {
		return out
	}
	for _, slot := range []string{"primary", "secondary"} {
		entry, ok := limits[slot].(map[string]any)
		if !ok {
			continue
		}
		minutes := numAt(entry, "windowDurationMins", "window_minutes")
		// Without a duration there is no way to say WHICH window this is, and
		// guessing from the slot is the bug this whole file is shaped around.
		if minutes == nil {
			continue
		}
		out = append(out, RawWindow{
			Key:      WindowKeyForDuration(*minutes),
			UsedPct:  numAt(entry, "usedPercent", "used_percent"),
			ResetsAt: numAt(entry, "resetsAt", "resets_at"),
		})
	}
	return out
}

// TranscriptFunc is the test seam: read a canned transcript instead of spawning
// anything.
type TranscriptFunc func() (string, bool)

// RPCCLIOptions configures one JSON-RPC provider.
type RPCCLIOptions struct {
	ID string
	// Bin is the binary to spawn; it defaults to ID, because a provider is
	// identified by its CLI binary name.
	Bin         string
	Args        []string
	ProcessName string
	TimeoutMs   int
	Transcript  TranscriptFunc
	Now         func() int64
	ProcDir     string
	// Home roots the per-user binary search; empty resolves the real one.
	Home string
}

// RPCCLIProvider asks a CLI over its own app-server protocol.
type RPCCLIProvider struct {
	id          string
	bin         string
	args        []string
	processName string
	timeoutMs   int
	transcript  TranscriptFunc
	now         func() int64
	procDir     string
	home        string

	// The empty-answer hold-off (see the constants above). Guarded because the
	// collector may be retuned while a pass is in flight.
	mu         sync.Mutex
	nextTrySec int64
	backoffSec int64
}

// NewRPCCLIProvider builds a provider, filling in the defaults for anything
// omitted.
func NewRPCCLIProvider(options RPCCLIOptions) *RPCCLIProvider {
	provider := &RPCCLIProvider{
		id:          options.ID,
		bin:         options.Bin,
		args:        options.Args,
		processName: options.ProcessName,
		timeoutMs:   boundMs(options.TimeoutMs, defaultRPCTimeoutMs),
		transcript:  options.Transcript,
		now:         options.Now,
		procDir:     options.ProcDir,
		home:        options.Home,
	}
	if provider.bin == "" {
		provider.bin = options.ID
	}
	if provider.args == nil {
		provider.args = []string{"app-server"}
	}
	if provider.processName == "" {
		provider.processName = options.ID
	}
	if provider.now == nil {
		provider.now = nowSeconds
	}
	return provider
}

// ID is the provider id, echoed to the server as-is.
func (p *RPCCLIProvider) ID() string { return p.id }

// ProcessCount counts live processes of the CLI by exact name.
func (p *RPCCLIProvider) ProcessCount(ctx context.Context) int {
	return CountProcesses(ctx, p.processName, ProcessCountOptions{ProcDir: p.procDir})
}

// Windows asks the CLI and normalises what it says.
//
// An ask that yields nothing — the binary missing, the stream unanswered, or an
// answer with no usable window — arms the hold-off, and while it is armed this
// returns empty without asking. Only a non-empty answer disarms it, so a host
// where the CLI sits idle stops paying the spawn every pass, and one where it is
// in use keeps its gauge fresh.
func (p *RPCCLIProvider) Windows(ctx context.Context) []protocol.UsageWindow {
	empty := []protocol.UsageWindow{}
	p.mu.Lock()
	held := p.now() < p.nextTrySec
	p.mu.Unlock()
	if held {
		return empty
	}

	read := p.transcript
	if read == nil {
		read = func() (string, bool) { return p.spawnAndRead(ctx) }
	}
	stdout, ok := read()
	if !ok {
		p.holdOff()
		return empty
	}
	result, answered := ExtractRPCResult(stdout)
	if !answered {
		p.holdOff()
		return empty
	}
	windows := NormalizeWindows(WindowsFromRPCResult(result), p.now())
	if len(windows) == 0 {
		// ⚠ AN ANSWERED "NOTHING TO REPORT" BACKS OFF TOO. It is the authoritative
		// form of the same fact — this account has no windows to show right now —
		// and re-asking it every minute is the exact spend the hold-off exists to
		// stop. It clears the moment an answer carries a window.
		p.holdOff()
		return empty
	}
	p.mu.Lock()
	p.nextTrySec, p.backoffSec = 0, 0
	p.mu.Unlock()
	return windows
}

// holdOff arms (or doubles) the empty-answer backoff.
func (p *RPCCLIProvider) holdOff() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.backoffSec == 0 {
		p.backoffSec = rpcEmptyBackoffInitialSec
	} else if p.backoffSec < rpcEmptyBackoffCapSec {
		p.backoffSec *= 2
		if p.backoffSec > rpcEmptyBackoffCapSec {
			p.backoffSec = rpcEmptyBackoffCapSec
		}
	}
	p.nextTrySec = p.now() + p.backoffSec
}

// spawnAndRead writes the request, then reads until OUR answer arrives and kills
// the child.
//
// WHY IT DOES NOT WAIT FOR EXIT: the app server keeps the stream open for the
// next request, so it never exits on its own — waiting would pay the full
// timeout on every single pass.
//
// ⚠ THIS IS THE ONE CHILD PROCESS IN THE AGENT THAT DOES NOT GO THROUGH
// internal/sys, and the reason is structural: sys.Run has no stdin and returns
// only after the process exits, and this protocol needs both the write and the
// early stop. The discipline sys.Run enforces is kept here by hand — a deadline,
// SIGKILL rather than a polite signal (a process ignoring the clock has no reason
// to honour a polite one), a capped buffer, and a missing binary as an ordinary
// empty answer rather than an error.
func (p *RPCCLIProvider) spawnAndRead(ctx context.Context) (string, bool) {
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(p.timeoutMs)*time.Millisecond)
	defer cancel()

	// A service manager's PATH does not carry per-user installs, and these CLIs live
	// almost nowhere else — see `ResolveBinary`.
	resolved := ResolveBinary(p.bin, p.home)
	command := exec.CommandContext(runCtx, resolved, p.args...)
	// The CLI resolves its own runtime from PATH — see EnvForBinary.
	command.Env = EnvForBinary(resolved)
	command.Cancel = func() error { return command.Process.Kill() }
	command.WaitDelay = time.Second
	// stderr is dropped on purpose: these CLIs log freely to it, and none of it is
	// an answer to the question we asked.
	stdin, err := command.StdinPipe()
	if err != nil {
		return "", false
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return "", false
	}
	if err := command.Start(); err != nil {
		// Not installed, or not executable: a fact about the host, reported as no
		// windows rather than as a failure.
		return "", false
	}

	go func() {
		// The write is ignored on purpose: a CLI that has no such subcommand exits
		// immediately and this becomes EPIPE, which is answered by the absent result
		// below rather than by an error nobody could act on.
		_, _ = io.WriteString(stdin, RequestPayload())
	}()
	// ⚠ STDIN STAYS OPEN UNTIL WE HAVE THE ANSWER. Closing it here is what this
	// code used to do, and measured against codex 0.146 it is why the limits never
	// arrived: the app server reads EOF as "we are done", and drops the request it
	// had already been given. Isolated three ways -- both lines at once with stdin
	// closed answers nothing, the same two lines with stdin held open answer in
	// full, and delaying the second line does not help while the close remains. The
	// process is killed by `cancel()` below either way, so nothing is left running.
	defer func() { _ = stdin.Close() }()

	var transcript strings.Builder
	chunk := make([]byte, 4096)
	for transcript.Len() < maxTranscriptBytes {
		read, err := stdout.Read(chunk)
		if read > 0 {
			transcript.Write(chunk[:read])
			// Only worth re-scanning once a line has been terminated; an unterminated
			// tail cannot parse yet, and the final text is scanned again by the caller.
			if bytes.IndexByte(chunk[:read], '\n') >= 0 {
				if _, answered := ExtractRPCResult(transcript.String()); answered {
					break
				}
			}
		}
		if err != nil {
			break
		}
	}

	// Kill first, reap second: Wait would otherwise block for as long as the app
	// server feels like staying up.
	cancel()
	_ = command.Wait()

	text := transcript.String()
	return text, text != ""
}
