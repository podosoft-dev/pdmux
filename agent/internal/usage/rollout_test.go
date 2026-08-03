package usage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// event renders one transcript line in the shape the CLI writes: the rate limits
// sit inside an event envelope, not at the top level.
func event(usedPct float64, windowMinutes int, resetsAt int64) string {
	line, _ := json.Marshal(map[string]any{
		"timestamp": "2026-08-01T08:30:16.280Z",
		"type":      "event_msg",
		"payload": map[string]any{
			"type": "token_count",
			"rate_limits": map[string]any{
				"limit_id": "codex",
				"primary": map[string]any{
					"used_percent":   usedPct,
					"window_minutes": windowMinutes,
					"resets_at":      resetsAt,
				},
				"secondary": nil,
			},
		},
	})
	return string(line)
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestLastRateLimitsInTail(t *testing.T) {
	future := time.Now().Add(72 * time.Hour).Unix()

	t.Run("[TC-PDAGENT-108] takes the NEWEST event, not the first one it can parse", func(t *testing.T) {
		// A transcript holds thousands of these and they only ever move; reading
		// forwards would report a number that was true hours ago.
		tail := strings.Join([]string{
			`{"fragment": true`,
			event(4, 10080, future),
			`{"type":"event_msg","payload":{"type":"agent_message","message":"hello"}}`,
			event(9, 10080, future),
		}, "\n")

		limits, ok := LastRateLimitsInTail(tail)
		if !ok {
			t.Fatal("no rate limits found")
		}
		primary, _ := limits["primary"].(map[string]any)
		if got := primary["used_percent"]; fmt.Sprint(got) != "9" {
			t.Fatalf("used_percent = %v, want the newest (9)", got)
		}
	})

	t.Run("[TC-PDAGENT-108] never trusts the first line of a tail", func(t *testing.T) {
		// A tail starts mid-file, so its first line is a fragment. One that happens
		// to parse is the dangerous case: it would report a truncated record's
		// numbers as if they were whole.
		tail := event(4, 10080, future) + "\n" + `{"type":"other"}`
		if _, ok := LastRateLimitsInTail(tail); ok {
			t.Fatal("read the leading fragment as a whole record")
		}
	})

	t.Run("[TC-PDAGENT-108] steps over lines it cannot decode", func(t *testing.T) {
		// The file is appended to while it is read, so a half-written line is an
		// ordinary race rather than a reason to report nothing.
		tail := strings.Join([]string{
			`{"pad":1}`,
			event(4, 10080, future),
			`{"type":"event_msg","payload":{"rate_limits":{"primary":{"used_pe`,
		}, "\n")

		limits, ok := LastRateLimitsInTail(tail)
		if !ok {
			t.Fatal("one truncated line lost the whole answer")
		}
		primary, _ := limits["primary"].(map[string]any)
		if fmt.Sprint(primary["used_percent"]) != "4" {
			t.Fatalf("used_percent = %v", primary["used_percent"])
		}
	})

	t.Run("[TC-PDAGENT-108] says nothing when the tail holds no event", func(t *testing.T) {
		tail := "{\"pad\":1}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\"}}"
		if _, ok := LastRateLimitsInTail(tail); ok {
			t.Fatal("invented an answer")
		}
	})
}

func TestRolloutFileProviderWindows(t *testing.T) {
	future := time.Now().Add(72 * time.Hour).Unix()

	t.Run("[TC-PDAGENT-108] names the window by its DURATION, not by its slot", func(t *testing.T) {
		// The measured account carries the weekly window in `primary` with
		// `secondary` null — reading the slot as the identity is the bug the RPC
		// mapper was already shaped around, and this path shares that mapper.
		root := t.TempDir()
		write(t, filepath.Join(root, "2026", "08", "01", "rollout-a.jsonl"),
			"{\"pad\":1}\n"+event(4, 10080, future)+"\n")

		provider := NewRolloutFileProvider(RolloutFileOptions{ID: "codex", Root: root})
		windows := provider.Windows(context.Background())
		if len(windows) != 1 {
			t.Fatalf("windows = %+v, want one", windows)
		}
		if windows[0].Key != WindowWeekly {
			t.Fatalf("key = %q, want %q — 10080 minutes is a week", windows[0].Key, WindowWeekly)
		}
		// Both polarities, as the wire contract requires.
		if windows[0].UsedPct == nil || *windows[0].UsedPct != 4 {
			t.Fatalf("usedPct = %v", windows[0].UsedPct)
		}
		if windows[0].RemainingPct == nil || *windows[0].RemainingPct != 96 {
			t.Fatalf("remainingPct = %v", windows[0].RemainingPct)
		}
	})

	t.Run("[TC-PDAGENT-108] an absent tree is an empty answer, not an error", func(t *testing.T) {
		// The CLI is simply not installed here. No rows, no zeros — the same rule
		// every other provider follows.
		provider := NewRolloutFileProvider(RolloutFileOptions{
			ID: "codex", Root: filepath.Join(t.TempDir(), "nope"),
		})
		if windows := provider.Windows(context.Background()); len(windows) != 0 {
			t.Fatalf("windows = %+v, want none", windows)
		}
	})

	t.Run("[TC-PDAGENT-108] a window that has already reset is dropped", func(t *testing.T) {
		root := t.TempDir()
		past := time.Now().Add(-time.Hour).Unix()
		write(t, filepath.Join(root, "2026", "08", "01", "rollout-a.jsonl"),
			"{\"pad\":1}\n"+event(4, 10080, past)+"\n")

		provider := NewRolloutFileProvider(RolloutFileOptions{ID: "codex", Root: root})
		if windows := provider.Windows(context.Background()); len(windows) != 0 {
			t.Fatalf("windows = %+v, want none — that budget has already reset", windows)
		}
	})
}

func TestNewestTranscript(t *testing.T) {
	t.Run("[TC-PDAGENT-109] descends the newest branch of the date tree", func(t *testing.T) {
		root := t.TempDir()
		write(t, filepath.Join(root, "2026", "07", "31", "rollout-old.jsonl"), "{}\n")
		write(t, filepath.Join(root, "2026", "08", "01", "rollout-new.jsonl"), "{}\n")

		got, ok := NewestTranscript(root)
		if !ok {
			t.Fatal("found nothing")
		}
		if filepath.Base(got) != "rollout-new.jsonl" {
			t.Fatalf("picked %q", filepath.Base(got))
		}
	})

	t.Run("[TC-PDAGENT-109] within a day, the most recently WRITTEN file wins", func(t *testing.T) {
		// A transcript is appended to for as long as its session lives, so the file
		// with the newest name is not necessarily the one being written to.
		root := t.TempDir()
		dir := filepath.Join(root, "2026", "08", "01")
		write(t, filepath.Join(dir, "rollout-2026-08-01T09-00-00-aaa.jsonl"), "{}\n")
		write(t, filepath.Join(dir, "rollout-2026-08-01T23-00-00-zzz.jsonl"), "{}\n")
		old := time.Now().Add(-2 * time.Hour)
		if err := os.Chtimes(filepath.Join(dir, "rollout-2026-08-01T23-00-00-zzz.jsonl"), old, old); err != nil {
			t.Fatalf("chtimes: %v", err)
		}

		got, _ := NewestTranscript(root)
		if !strings.Contains(filepath.Base(got), "aaa") {
			t.Fatalf("picked %q, want the one still being written", filepath.Base(got))
		}
	})

	t.Run("[TC-PDAGENT-109] still answers when the tree is flat", func(t *testing.T) {
		root := t.TempDir()
		write(t, filepath.Join(root, "rollout-a.jsonl"), "{}\n")
		if _, ok := NewestTranscript(root); !ok {
			t.Fatal("a flat directory found nothing")
		}
	})
}

func TestReadFileTail(t *testing.T) {
	t.Run("[TC-PDAGENT-109] reads the END of a large file, not the file", func(t *testing.T) {
		// The measured transcript was 16 MiB after one day. Reading it whole every
		// minute would replace a process spawn with an allocation just as unwelcome.
		path := filepath.Join(t.TempDir(), "big.jsonl")
		filler := strings.Repeat("{\"pad\":\""+strings.Repeat("x", 900)+"\"}\n", 2000)
		write(t, path, filler+"{\"marker\":\"last\"}\n")

		tail, ok := ReadFileTail(path)
		if !ok {
			t.Fatal("read failed")
		}
		if len(tail) > TailBytes {
			t.Fatalf("tail = %d bytes, want at most %d", len(tail), TailBytes)
		}
		if !strings.Contains(tail, `"marker":"last"`) {
			t.Fatal("the end of the file is missing from its tail")
		}
		info, _ := os.Stat(path)
		if info.Size() <= TailBytes {
			t.Fatalf("fixture is only %d bytes — it does not exercise the seek", info.Size())
		}
	})

	t.Run("[TC-PDAGENT-109] drops the trailing partial line", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "small.jsonl")
		write(t, path, "{\"a\":1}\n{\"b\":2}\n{\"half\":")

		tail, _ := ReadFileTail(path)
		if strings.Contains(tail, "half") {
			t.Fatalf("kept a half-written line: %q", tail)
		}
	})
}

// countingProvider answers with whatever it was given and records being asked.
// Named apart from usage_test.go's stubProvider because these cases turn on WHO
// was asked, which that one does not record for Windows.
type countingProvider struct {
	id      string
	windows []protocol.UsageWindow
	asked   *int
}

func (s countingProvider) ID() string                       { return s.id }
func (s countingProvider) ProcessCount(context.Context) int { return 3 }
func (s countingProvider) Windows(context.Context) []protocol.UsageWindow {
	*s.asked++
	return s.windows
}

func TestFirstAnswering(t *testing.T) {
	window := []protocol.UsageWindow{{Key: WindowWeekly}}

	t.Run("[TC-PDAGENT-110] never reaches the expensive provider when the cheap one answers", func(t *testing.T) {
		// This is the whole saving. If the fallback runs anyway, the CLI is spawned
		// on every pass and nothing has been gained.
		cheapAsked, dearAsked := 0, 0
		p := NewFirstAnswering("codex",
			countingProvider{id: "cheap", windows: window, asked: &cheapAsked},
			countingProvider{id: "dear", windows: window, asked: &dearAsked},
		)
		if got := p.Windows(context.Background()); len(got) != 1 {
			t.Fatalf("windows = %+v", got)
		}
		if cheapAsked != 1 || dearAsked != 0 {
			t.Fatalf("cheap asked %d, expensive asked %d — want 1 and 0", cheapAsked, dearAsked)
		}
	})

	t.Run("[TC-PDAGENT-110] falls through when the cheap one has nothing", func(t *testing.T) {
		cheapAsked, dearAsked := 0, 0
		p := NewFirstAnswering("codex",
			countingProvider{id: "cheap", windows: nil, asked: &cheapAsked},
			countingProvider{id: "dear", windows: window, asked: &dearAsked},
		)
		if got := p.Windows(context.Background()); len(got) != 1 {
			t.Fatalf("windows = %+v, want the fallback's answer", got)
		}
		if dearAsked != 1 {
			t.Fatalf("expensive asked %d, want 1", dearAsked)
		}
	})

	t.Run("[TC-PDAGENT-110] an empty answer stays empty rather than becoming an error", func(t *testing.T) {
		cheapAsked, dearAsked := 0, 0
		p := NewFirstAnswering("codex",
			countingProvider{id: "cheap", asked: &cheapAsked},
			countingProvider{id: "dear", asked: &dearAsked},
		)
		if got := p.Windows(context.Background()); got == nil || len(got) != 0 {
			t.Fatalf("windows = %+v, want an empty non-nil list", got)
		}
	})
}
