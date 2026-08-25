package usage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// answerLine is the frame the CLI sends back for OUR request id.
func answerLine(t *testing.T, limits any) string {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": rpcRequestID, "result": map[string]any{"rateLimits": limits},
	})
	if err != nil {
		t.Fatalf("encoding answer: %v", err)
	}
	return string(encoded)
}

// fakeAppServer writes a CLI that answers on stdout and then STAYS UP, which is
// what the real app server does — it keeps the stream open for the next request.
// A provider that waited for exit would pay its whole timeout here.
func fakeAppServer(t *testing.T, lines []string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a /bin/sh script")
	}
	path := filepath.Join(t.TempDir(), "codex")
	script := "#!/bin/sh\n"
	for _, line := range lines {
		script += "printf '%s\\n' '" + line + "'\n"
	}
	// exec so the killed pid IS the sleeping process, leaving no orphan behind.
	script += "exec sleep 30\n"
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatalf("writing fake app server: %v", err)
	}
	return path
}

func TestRPCCLIProvider(t *testing.T) {
	twoWindows := map[string]any{
		"primary":   map[string]any{"usedPercent": 12, "windowDurationMins": 300, "resetsAt": testNow + 600},
		"secondary": map[string]any{"usedPercent": 44, "windowDurationMins": 10_080, "resetsAt": testNow + 86_400},
	}

	t.Run("[TC-PDAGENT-019] reads the answer out of a JSON-RPC transcript", func(t *testing.T) {
		transcript := strings.Join([]string{
			`{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex"}}`,
			"a stray log line that is not json",
			`{"jsonrpc":"2.0","method":"notification","params":{}}`,
			answerLine(t, twoWindows),
		}, "\n")
		provider := NewRPCCLIProvider(RPCCLIOptions{
			ID:         "codex",
			Transcript: func() (string, bool) { return transcript, true },
			Now:        func() int64 { return testNow },
		})
		got := provider.Windows(t.Context())
		if len(got) != 2 {
			t.Fatalf("windows = %+v, want two", got)
		}
		if got[0].Key != WindowSession || mustInt(t, got[0].UsedPct, "usedPct") != 12 ||
			mustInt(t, got[0].RemainingPct, "remainingPct") != 88 {
			t.Fatalf("session window = %+v", got[0])
		}
		if got[1].Key != WindowWeekly || mustInt(t, got[1].UsedPct, "usedPct") != 44 ||
			mustInt(t, got[1].RemainingPct, "remainingPct") != 56 {
			t.Fatalf("weekly window = %+v", got[1])
		}
	})

	t.Run("[TC-PDAGENT-019] reports nothing when the CLI answered nothing usable", func(t *testing.T) {
		provider := NewRPCCLIProvider(RPCCLIOptions{
			ID:         "codex",
			Transcript: func() (string, bool) { return "command not found", true },
			Now:        func() int64 { return testNow },
		})
		if got := provider.Windows(t.Context()); len(got) != 0 {
			t.Fatalf("windows = %+v, want none", got)
		}
	})

	t.Run("[TC-PDAGENT-019] tells an unanswered stream apart from an answered one", func(t *testing.T) {
		// `null` here is the CLI SAYING it has no limits; the absent case is a CLI
		// that has not answered yet, and only the first ends the read.
		result, answered := ExtractRPCResult(`{"jsonrpc":"2.0","id":2,"result":null}`)
		if !answered || result != nil {
			t.Fatalf("result = %v (answered=%v), want a nil result that counts as answered", result, answered)
		}
		if _, answered := ExtractRPCResult(`{"jsonrpc":"2.0","id":1,"result":{}}`); answered {
			t.Fatal("another request's answer was read as ours")
		}
		if _, answered := ExtractRPCResult(`{"jsonrpc":"2.0","id":2,"resu`); answered {
			t.Fatal("a half-received line was read as an answer")
		}
	})

	t.Run("[TC-PDAGENT-016] maps windows by duration, never by array position", func(t *testing.T) {
		// The measured account: the WEEKLY window arrived in `primary`.
		raws := WindowsFromRPCResult(map[string]any{"rateLimits": map[string]any{
			"primary":   map[string]any{"usedPercent": 30.0, "windowDurationMins": 10_080.0, "resetsAt": float64(testNow + 3_600)},
			"secondary": nil,
		}})
		if len(raws) != 1 {
			t.Fatalf("raw windows = %+v, want one", raws)
		}
		if raws[0].Key != WindowWeekly {
			t.Fatalf("key = %q, want %q — the slot is not the window's identity", raws[0].Key, WindowWeekly)
		}
		if raws[0].UsedPct == nil || *raws[0].UsedPct != 30 {
			t.Fatalf("usedPct = %v, want 30", raws[0].UsedPct)
		}
	})

	t.Run("[TC-PDAGENT-016] drops a window that does not say how long it is", func(t *testing.T) {
		raws := WindowsFromRPCResult(map[string]any{"rateLimits": map[string]any{
			"primary": map[string]any{"usedPercent": 30.0},
		}})
		if len(raws) != 0 {
			t.Fatalf("raw windows = %+v, want none: without a duration there is no way to say which window it is", raws)
		}
	})

	t.Run("spawns the CLI, stops at its own answer and does not wait for exit", func(t *testing.T) {
		bin := fakeAppServer(t, []string{
			`{"jsonrpc":"2.0","id":1,"result":{}}`,
			answerLine(t, twoWindows),
		})
		provider := NewRPCCLIProvider(RPCCLIOptions{
			ID: "codex", Bin: bin, Args: []string{"app-server"},
			TimeoutMs: 8_000, Now: func() int64 { return testNow },
		})

		started := time.Now()
		got := provider.Windows(t.Context())
		elapsed := time.Since(started)

		if len(got) != 2 {
			t.Fatalf("windows = %+v, want two", got)
		}
		// The child sleeps for 30s after answering: anything close to the timeout
		// means the read waited for a process that never exits.
		if elapsed > 4*time.Second {
			t.Fatalf("read took %s, want it to end at the answer", elapsed)
		}
	})

	t.Run("[TC-PDMCP-011] holds stdin open until the CLI has answered", func(t *testing.T) {
		// ⚠ THE BUG THIS PINS. The agent used to close stdin the moment it had
		// written the request. codex 0.146's app server reads that EOF as "we are
		// done" and drops the request it was already given, so the limits never
		// arrived — and the symptom (no reply at all) was misread as the method
		// having been removed from the CLI.
		//
		// The fake answers only if its stdin is STILL OPEN when it gets there, which
		// is exactly the condition the real one imposes.
		path := filepath.Join(t.TempDir(), "codex")
		// Two reads take the request lines (`head` would buffer past them). The third
		// is the probe: at EOF it returns instantly, and on a pipe that is still open
		// it blocks for its timeout. `read -t` cannot say which happened -- macOS
		// /bin/sh answers 1 either way -- so the ELAPSED TIME is the signal.
		script := "#!/bin/bash\n" +
			"read -t 2 _\n" +
			"read -t 2 _\n" +
			"before=$(date +%s)\n" +
			"read -t 3 _\n" +
			"after=$(date +%s)\n" +
			"if [ $((after - before)) -lt 2 ]; then exec sleep 30; fi\n" +
			"printf '%s\\n' '" + answerLine(t, twoWindows) + "'\n" +
			"exec sleep 30\n"
		if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
			t.Fatalf("writing fake app server: %v", err)
		}
		provider := NewRPCCLIProvider(RPCCLIOptions{
			ID: "codex", Bin: path, Args: []string{"app-server"},
			TimeoutMs: 8_000, Now: func() int64 { return testNow },
		})
		if got := provider.Windows(t.Context()); len(got) != 2 {
			t.Fatalf("windows = %+v, want two", got)
		}
	})

	t.Run("reports nothing when the CLI is not installed", func(t *testing.T) {
		provider := NewRPCCLIProvider(RPCCLIOptions{
			ID: "codex", Bin: filepath.Join(t.TempDir(), "absent"),
			TimeoutMs: 2_000, Now: func() int64 { return testNow },
		})
		if got := provider.Windows(t.Context()); len(got) != 0 {
			t.Fatalf("windows = %+v, want none", got)
		}
	})

	t.Run("asks the two questions the protocol requires, in order", func(t *testing.T) {
		payload := RequestPayload()
		lines := strings.Split(strings.TrimRight(payload, "\n"), "\n")
		if len(lines) != 2 {
			t.Fatalf("payload = %q, want two lines", payload)
		}
		var handshake, question map[string]any
		if err := json.Unmarshal([]byte(lines[0]), &handshake); err != nil {
			t.Fatalf("handshake is not JSON: %v", err)
		}
		if err := json.Unmarshal([]byte(lines[1]), &question); err != nil {
			t.Fatalf("question is not JSON: %v", err)
		}
		if handshake["method"] != "initialize" {
			t.Fatalf("first method = %v, want initialize", handshake["method"])
		}
		if question["method"] != "account/rateLimits/read" {
			t.Fatalf("second method = %v", question["method"])
		}
		if fmt.Sprint(question["id"]) != fmt.Sprint(rpcRequestID) {
			t.Fatalf("question id = %v, want %d — the reader matches on it", question["id"], rpcRequestID)
		}
	})
}

func TestRateLimitsNotification(t *testing.T) {
	// ⚠ THE REQUEST/RESPONSE METHOD WENT AWAY. `account/rateLimits/read` is answered by
	// nothing in codex 0.145 — no result, no error, no reply — so the reader timed out and
	// reported "no windows", indistinguishable from a CLI that is not installed. Verified
	// against the shipped binary: its method table has `account/rateLimits/updated` and no
	// `.../read`, and the payload field names are unchanged.
	const notification = `{"jsonrpc":"2.0","method":"account/rateLimits/updated","params":` +
		`{"rateLimits":{"primary":{"windowDurationMins":300,"usedPercent":40,"resetsAt":4102444800}}}}`

	t.Run("[TC-PDAGENT-105] reads limits a current CLI volunteers as a notification", func(t *testing.T) {
		result, found := ExtractRPCResult("some log line\n" + notification + "\n")
		if !found {
			t.Fatal("the notification was not recognised as an answer")
		}
		windows := WindowsFromRPCResult(result)
		if len(windows) != 1 {
			t.Fatalf("windows = %d, want 1", len(windows))
		}
		if windows[0].Key != "session" {
			t.Fatalf("key = %q, want session (300 min is a session window)", windows[0].Key)
		}
	})

	t.Run("[TC-PDAGENT-105] still reads an older CLI's request answer", func(t *testing.T) {
		// Accepting the notification must not drop the shape that already worked.
		answer := `{"jsonrpc":"2.0","id":2,"result":{"rateLimits":{"secondary":` +
			`{"windowDurationMins":10080,"usedPercent":10,"resetsAt":4102444800}}}}`
		result, found := ExtractRPCResult(answer + "\n")
		if !found {
			t.Fatal("the id-2 result was not recognised")
		}
		windows := WindowsFromRPCResult(result)
		if len(windows) != 1 || windows[0].Key != "weekly" {
			t.Fatalf("windows = %+v, want one weekly window", windows)
		}
	})

	t.Run("[TC-PDAGENT-105] an unrelated notification is not an answer", func(t *testing.T) {
		// These CLIs chatter on the same stream; treating any notification as the answer
		// would end the read before the limits ever arrive.
		if _, found := ExtractRPCResult(`{"method":"configWarning","params":{"summary":"x"}}` + "\n"); found {
			t.Fatal("an unrelated notification was treated as the answer")
		}
	})
}

// TestEmptyAnswerHoldsOffTheNextAsk pins the negative cache on the RPC provider.
//
// ⚠ THE COST BEING GUARDED IS THE SPAWN, NOT THE PARSE. On a host where the CLI
// is installed but idle, every collection used to spawn the launcher and its
// ~259 MB native binary to buy the same empty answer — measured overnight on two
// paging 15 GB hosts as 74 and 52 heartbeats stretched to 2.1-9.7 s, at exactly
// the collector's 60 s cadence. Revert the hold-off in Windows and the first
// subtest fails on asks=2.
func TestEmptyAnswerHoldsOffTheNextAsk(t *testing.T) {
	t.Run("an empty answer is not re-bought before the hold-off elapses", func(t *testing.T) {
		now := int64(testNow)
		asks := 0
		provider := NewRPCCLIProvider(RPCCLIOptions{
			ID:         "codex",
			Transcript: func() (string, bool) { asks++; return "", false },
			Now:        func() int64 { return now },
		})

		provider.Windows(t.Context())
		provider.Windows(t.Context())
		if asks != 1 {
			t.Fatalf("asks = %d after two passes, want 1 — the empty answer was re-bought", asks)
		}

		now += rpcEmptyBackoffInitialSec - 1
		provider.Windows(t.Context())
		if asks != 1 {
			t.Fatalf("asks = %d one second before the hold-off elapsed, want 1", asks)
		}

		now += 1
		provider.Windows(t.Context())
		if asks != 2 {
			t.Fatalf("asks = %d after the hold-off elapsed, want 2", asks)
		}
	})

	t.Run("consecutive empties double the hold-off up to the cap", func(t *testing.T) {
		now := int64(testNow)
		asks := 0
		provider := NewRPCCLIProvider(RPCCLIOptions{
			ID:         "codex",
			Transcript: func() (string, bool) { asks++; return "", false },
			Now:        func() int64 { return now },
		})

		// Each loop lets the current hold-off elapse exactly, asks again (another
		// empty), and expects the next hold-off to have doubled — 10m, 20m, 30m,
		// then pinned at the cap.
		provider.Windows(t.Context())
		for i, wait := range []int64{
			rpcEmptyBackoffInitialSec,
			rpcEmptyBackoffInitialSec * 2,
			rpcEmptyBackoffCapSec,
			rpcEmptyBackoffCapSec,
		} {
			now += wait - 1
			provider.Windows(t.Context())
			if asks != i+1 {
				t.Fatalf("step %d: asks = %d just inside the hold-off, want %d", i, asks, i+1)
			}
			now += 1
			provider.Windows(t.Context())
			if asks != i+2 {
				t.Fatalf("step %d: asks = %d after the hold-off, want %d", i, asks, i+2)
			}
		}
	})

	t.Run("a real answer clears the hold-off", func(t *testing.T) {
		now := int64(testNow)
		asks := 0
		// resetsAt sits far past every clock advance below: the normaliser drops an
		// expired window, and this subtest is about the hold-off, not expiry.
		answer := answerLine(t, map[string]any{
			"primary": map[string]any{"usedPercent": 12, "windowDurationMins": 300, "resetsAt": testNow + 100_000},
		})
		full := false
		provider := NewRPCCLIProvider(RPCCLIOptions{
			ID: "codex",
			Transcript: func() (string, bool) {
				asks++
				if full {
					return answer, true
				}
				return "", false
			},
			Now: func() int64 { return now },
		})

		provider.Windows(t.Context()) // empty -> hold-off armed
		full = true
		now += rpcEmptyBackoffInitialSec
		if got := provider.Windows(t.Context()); len(got) != 1 {
			t.Fatalf("windows = %+v, want the answered window", got)
		}
		// ⚠ THIS USED TO ASSERT AN IMMEDIATE RE-ASK, AND THAT EXPECTATION WAS THE
		// BUG: a reliable answer re-bought every pass is the 60-a-hour spawn the
		// field measurement caught. What "cleared" must mean is that the EMPTY
		// backoff left no residue — so after the success's own refresh interval,
		// the next empty starts over at the INITIAL hold-off, not a doubled one.
		now += rpcRefreshSec
		full = false
		provider.Windows(t.Context()) // asks again (refresh elapsed), empty -> initial hold-off
		if asks != 3 {
			t.Fatalf("asks = %d after the refresh interval, want 3", asks)
		}
		now += rpcEmptyBackoffInitialSec - 1
		provider.Windows(t.Context())
		if asks != 3 {
			t.Fatalf("asks = %d — the post-success empty was held for more than the initial hold-off", asks)
		}
		now += 1
		provider.Windows(t.Context())
		if asks != 4 {
			t.Fatalf("asks = %d — the post-success empty never released", asks)
		}
	})
}

// TestFullAnswerIsServedForTheRefreshInterval pins the success-side throttle.
//
// ⚠ SUCCESS IS THE EXPENSIVE CASE THIS ROUND. The empty-answer backoff shipped
// first and the spawns kept coming at the collector's 60 s cadence, because the
// answers were full — a reliable fallback cleared the backoff every pass. Revert
// the refresh gate and the first assertion fails on asks=2.
func TestFullAnswerIsServedForTheRefreshInterval(t *testing.T) {
	now := int64(testNow)
	asks := 0
	// The session window resets INSIDE the refresh interval, so the mid-interval
	// serve below can watch it drop out of the cache; the weekly one outlives
	// every clock advance here.
	answer := answerLine(t, map[string]any{
		"primary":   map[string]any{"usedPercent": 12, "windowDurationMins": 300, "resetsAt": testNow + 300},
		"secondary": map[string]any{"usedPercent": 44, "windowDurationMins": 10_080, "resetsAt": testNow + 100_000},
	})
	provider := NewRPCCLIProvider(RPCCLIOptions{
		ID:         "codex",
		Transcript: func() (string, bool) { asks++; return answer, true },
		Now:        func() int64 { return now },
	})

	if got := provider.Windows(t.Context()); len(got) != 2 {
		t.Fatalf("first ask = %+v, want two windows", got)
	}
	if got := provider.Windows(t.Context()); len(got) != 2 || asks != 1 {
		t.Fatalf("second pass: windows=%d asks=%d, want the cached answer without a second ask", len(got), asks)
	}

	// The session window's reset passes mid-interval: the served cache must lose
	// it at once — a window outliving its own reset is a lying gauge — while the
	// weekly window stays.
	now = testNow + 500
	if got := provider.Windows(t.Context()); len(got) != 1 || got[0].Key != WindowWeekly || asks != 1 {
		t.Fatalf("after session reset: windows=%+v asks=%d, want only the weekly window from cache", got, asks)
	}

	// Past the refresh interval the CLI is asked again.
	now = testNow + rpcRefreshSec
	provider.Windows(t.Context())
	if asks != 2 {
		t.Fatalf("asks = %d past the refresh interval, want 2", asks)
	}
}
