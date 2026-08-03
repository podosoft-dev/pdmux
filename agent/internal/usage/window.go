package usage

// Usage-window normalisation — the two bugs this file exists to prevent.
//
//  1. AN ELAPSED WINDOW IS NOT DATA. A snapshot whose reset time has passed
//     describes a window that no longer exists. A nine-day-old sample kept
//     claiming "95% left" on a card while the live account was nearly spent.
//  2. WINDOWS ARE IDENTIFIED BY DURATION, NEVER BY POSITION. A measured account
//     returned the WEEKLY window in the provider's `primary` slot with
//     `secondary` null; trusting the array order labels the weekly budget as the
//     session one and draws a reassuring bar for the wrong thing.
//
// Ported from apps/agent/src/usage/window.ts.

import (
	"math"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// The two window keys the adapters produce. A UI translates these; anything else
// a third-party adapter invents travels as-is.
const (
	WindowSession = "session"
	WindowWeekly  = "weekly"
)

// SessionMaxMinutes is the boundary: anything up to half a day is a session
// window, longer is the weekly one.
const SessionMaxMinutes = 720

// usageWindow.key/label maxLength in the contract. A window one character over
// either would fail the element, the array, and the whole heartbeat — so the
// value costs its own tail rather than the host's card.
const (
	windowKeyMax   = 32
	windowLabelMax = 64
)

// WindowKeyForDuration names a window by how long it lasts, which is the only
// property a provider cannot get wrong.
func WindowKeyForDuration(minutes float64) string {
	if minutes <= SessionMaxMinutes {
		return WindowSession
	}
	return WindowWeekly
}

// RawWindow is one window exactly as a provider reported it, before any
// judgement is applied.
//
// The percentages are float64 POINTERS rather than ints because both facts
// matter: a provider may report 0.4% spent (the fraction is what makes flooring
// the remaining side meaningful), and "did not report this at all" has to stay
// distinguishable from "reported zero".
type RawWindow struct {
	Key string
	// Label is absent when empty. It is one of the two genuinely optional fields
	// in the whole protocol: absent means the KEY is left out, never sent as "".
	Label string
	// UsedPct is the percent of the budget consumed, as the provider reported it.
	UsedPct *float64
	// RemainingPct is the percent left, for providers that report that polarity.
	RemainingPct *float64
	ResetsAt     *float64
}

// NormalizeWindow renders one window in the wire shape. ok is false when the
// window is unusable or has already reset.
//
// BOTH POLARITIES ARE STORED. Providers disagree about which direction they
// report, and remaining is FLOORED rather than rounded: 0.4% spent is 99% left,
// not 100%. A gauge reading full while something has been spent is the one lie
// worth writing extra code to avoid.
func NormalizeWindow(raw RawWindow, nowSec int64) (protocol.UsageWindow, bool) {
	window := protocol.NewUsageWindow()

	var resetsAt *int64
	if raw.ResetsAt != nil && finite(*raw.ResetsAt) {
		seconds := int64(math.Floor(*raw.ResetsAt))
		if seconds <= nowSec {
			return window, false
		}
		resetsAt = &seconds
	}

	// The contract requires a non-empty key; a keyless window would fail the whole
	// heartbeat, so it is dropped the way a nameless session is (collect/sessions.go).
	key := truncateRunes(raw.Key, windowKeyMax)
	if key == "" {
		return window, false
	}

	var used, remaining int
	switch {
	case raw.UsedPct != nil && finite(*raw.UsedPct):
		spent := clampPct(*raw.UsedPct)
		used = int(math.Round(spent))
		remaining = int(math.Floor(100 - spent))
	case raw.RemainingPct != nil && finite(*raw.RemainingPct):
		left := clampPct(*raw.RemainingPct)
		remaining = int(math.Floor(left))
		used = int(math.Round(100 - left))
	default:
		// Neither polarity carried a number: there is nothing to draw, and a zero
		// here would draw a full gauge for a budget nobody measured.
		return window, false
	}

	window.Key = key
	if raw.Label != "" {
		label := truncateRunes(raw.Label, windowLabelMax)
		window.Label = &label
	}
	window.UsedPct = &used
	window.RemainingPct = &remaining
	window.ResetsAt = resetsAt
	return window, true
}

// NormalizeWindows normalises a batch, dropping everything unusable. Order is
// preserved — a card whose bars reorder between passes reads as flapping even
// when the numbers did not move.
func NormalizeWindows(raws []RawWindow, nowSec int64) []protocol.UsageWindow {
	// Never nil: a nil slice marshals to `null`, which the server rejects.
	out := []protocol.UsageWindow{}
	for _, raw := range raws {
		if window, ok := NormalizeWindow(raw, nowSec); ok {
			out = append(out, window)
		}
	}
	return out
}

func clampPct(value float64) float64 {
	return math.Max(0, math.Min(100, value))
}

// finite is Number.isFinite: JSON cannot carry NaN or ±Inf, but a computed value
// can, and converting either to int is undefined behaviour in Go.
func finite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// numAt is the TypeScript's `num(obj[a] ?? obj[b])`, which both adapters use to
// read a document written by somebody else's tool.
//
// `??` only falls through for null or a missing key, so a key that IS present
// but holds a string yields "no number" rather than silently using the
// alternative spelling — the same value read two different ways is how a
// snapshot format change turns into a plausible-looking wrong number.
func numAt(object map[string]any, keys ...string) *float64 {
	for _, key := range keys {
		value, present := object[key]
		if !present || value == nil {
			continue
		}
		number, ok := value.(float64)
		if !ok || !finite(number) {
			return nil
		}
		return &number
	}
	return nil
}

// truncateRunes clips to a rune count, never a byte count: half a rune is
// invalid UTF-8, and the contract's maxLength counts characters.
func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

func boundMs(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}
