package usage

import (
	"strings"
	"testing"
)

// testNow is the same fixed clock the TypeScript specs use, so a failure here is
// comparable with a failure there while both agents are in the field.
const testNow = int64(1_785_000_000)

func number(value float64) *float64 { return &value }

func mustInt(t *testing.T, value *int, what string) int {
	t.Helper()
	if value == nil {
		t.Fatalf("%s = nil, want a number", what)
	}
	return *value
}

func TestNormalizeWindow(t *testing.T) {
	t.Run("[TC-PDAGENT-015] drops a window whose reset time has already passed", func(t *testing.T) {
		if _, ok := NormalizeWindow(RawWindow{Key: WindowSession, UsedPct: number(5), ResetsAt: number(float64(testNow - 1))}, testNow); ok {
			t.Fatal("kept a window whose reset time has passed")
		}
		if _, ok := NormalizeWindow(RawWindow{Key: WindowSession, UsedPct: number(5), ResetsAt: number(float64(testNow + 60))}, testNow); !ok {
			t.Fatal("dropped a window that has not reset yet")
		}
	})

	t.Run("[TC-PDAGENT-015] stores both polarities and floors what is remaining", func(t *testing.T) {
		got, ok := NormalizeWindow(RawWindow{Key: WindowWeekly, UsedPct: number(0.4)}, testNow)
		if !ok {
			t.Fatal("dropped a usable window")
		}
		if got.Key != WindowWeekly {
			t.Fatalf("key = %q", got.Key)
		}
		// 0.4% spent is 99% left, not 100%: a gauge reading full while something has
		// been spent is the lie this flooring exists to prevent.
		if used := mustInt(t, got.UsedPct, "usedPct"); used != 0 {
			t.Fatalf("usedPct = %d, want 0", used)
		}
		if remaining := mustInt(t, got.RemainingPct, "remainingPct"); remaining != 99 {
			t.Fatalf("remainingPct = %d, want 99", remaining)
		}
		if got.ResetsAt != nil {
			t.Fatalf("resetsAt = %d, want null for a window with no reset time", *got.ResetsAt)
		}
	})

	t.Run("[TC-PDAGENT-015] accepts a provider that reports what is left instead", func(t *testing.T) {
		got, ok := NormalizeWindow(RawWindow{Key: WindowSession, RemainingPct: number(30)}, testNow)
		if !ok {
			t.Fatal("dropped a usable window")
		}
		if used := mustInt(t, got.UsedPct, "usedPct"); used != 70 {
			t.Fatalf("usedPct = %d, want 70", used)
		}
		if remaining := mustInt(t, got.RemainingPct, "remainingPct"); remaining != 30 {
			t.Fatalf("remainingPct = %d, want 30", remaining)
		}
	})

	t.Run("[TC-PDAGENT-015] drops a window carrying no number at all", func(t *testing.T) {
		got := NormalizeWindows([]RawWindow{{Key: WindowSession}, {Key: WindowWeekly, UsedPct: number(10)}}, testNow)
		if len(got) != 1 || got[0].Key != WindowWeekly {
			t.Fatalf("normalised %+v, want only the weekly window", got)
		}
	})

	t.Run("[TC-PDAGENT-015] clamps a provider that reports outside 0..100", func(t *testing.T) {
		over, ok := NormalizeWindow(RawWindow{Key: WindowSession, UsedPct: number(140)}, testNow)
		if !ok {
			t.Fatal("dropped an out-of-range window instead of clamping it")
		}
		if used := mustInt(t, over.UsedPct, "usedPct"); used != 100 {
			t.Fatalf("usedPct = %d, want 100", used)
		}
		if remaining := mustInt(t, over.RemainingPct, "remainingPct"); remaining != 0 {
			t.Fatalf("remainingPct = %d, want 0", remaining)
		}
		under, ok := NormalizeWindow(RawWindow{Key: WindowSession, RemainingPct: number(-5)}, testNow)
		if !ok {
			t.Fatal("dropped a negative remaining instead of clamping it")
		}
		if remaining := mustInt(t, under.RemainingPct, "remainingPct"); remaining != 0 {
			t.Fatalf("remainingPct = %d, want 0", remaining)
		}
	})

	t.Run("[TC-PDAGENT-016] maps windows by duration, never by array position", func(t *testing.T) {
		if got := WindowKeyForDuration(300); got != WindowSession {
			t.Fatalf("300 minutes = %q, want %q", got, WindowSession)
		}
		if got := WindowKeyForDuration(SessionMaxMinutes); got != WindowSession {
			t.Fatalf("%d minutes = %q, want %q", SessionMaxMinutes, got, WindowSession)
		}
		if got := WindowKeyForDuration(10_080); got != WindowWeekly {
			t.Fatalf("a week = %q, want %q", got, WindowWeekly)
		}
	})

	t.Run("clips key and label to the contract's lengths and omits an unset label", func(t *testing.T) {
		// One character over either would fail the element, the array and the whole
		// heartbeat — the host would vanish rather than show a long label.
		got, ok := NormalizeWindow(RawWindow{
			Key:     strings.Repeat("k", 100),
			Label:   strings.Repeat("é", 200),
			UsedPct: number(10),
		}, testNow)
		if !ok {
			t.Fatal("dropped a window with over-long strings")
		}
		if length := len([]rune(got.Key)); length != windowKeyMax {
			t.Fatalf("key length = %d, want %d", length, windowKeyMax)
		}
		if got.Label == nil {
			t.Fatal("label = nil, want the clipped label")
		}
		if length := len([]rune(*got.Label)); length != windowLabelMax {
			t.Fatalf("label length = %d, want %d", length, windowLabelMax)
		}

		bare, _ := NormalizeWindow(RawWindow{Key: WindowSession, UsedPct: number(10)}, testNow)
		// label is one of the two genuine optionals: absent, never "".
		if bare.Label != nil {
			t.Fatalf("label = %q, want it absent", *bare.Label)
		}
	})

	t.Run("drops a window with no key and never returns a nil slice", func(t *testing.T) {
		// A nil slice marshals to `null`, which fails the frame the host is judged by.
		got := NormalizeWindows([]RawWindow{{Key: "", UsedPct: number(10)}}, testNow)
		if got == nil {
			t.Fatal("windows = nil, want an empty (non-nil) list")
		}
		if len(got) != 0 {
			t.Fatalf("windows = %+v, want the keyless window dropped", got)
		}
		var empty []RawWindow
		if out := NormalizeWindows(empty, testNow); out == nil {
			t.Fatal("normalising nothing returned nil")
		}
	})
}
