package agent

import (
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/sample"
)

func ms(n int) time.Duration { return time.Duration(n) * time.Millisecond }

// TestStatsWorthInfo pins the level decision for the transport summary.
//
// ⚠ AT INFO ON EVERY TICK THE LINE WAS 75% OF THE AGENT'S JOURNAL — measured at
// ~120 of ~160 lines an hour per host — burying the history an incident reader
// needs. The decision has three duties: healthy intervals stay at debug, an
// interval that says something new is at info BEFORE the one-shot warnings
// would fire, and silence is bounded — one info an hour minimum, so an absent
// line always means "nothing noteworthy" and never "who knows".
func TestStatsWorthInfo(t *testing.T) {
	healthy := sample.Summary{P50: ms(0), P95: ms(2), Max: ms(4)}
	quietFor := 5 * time.Minute

	if statsWorthInfo(healthy, healthy, quietFor) {
		t.Fatal("a baseline interval was promoted to info — the journal fills with 'still healthy' again")
	}
	if !statsWorthInfo(sample.Summary{P95: ms(statsNoteworthyP95Ms)}, healthy, quietFor) {
		t.Fatal("a noteworthy write p95 stayed at debug — the interesting minute is off the record")
	}
	if !statsWorthInfo(sample.Summary{Max: ms(statsNoteworthyMaxMs)}, healthy, quietFor) {
		t.Fatal("a noteworthy write max stayed at debug")
	}
	if !statsWorthInfo(healthy, sample.Summary{P95: ms(statsNoteworthyP95Ms)}, quietFor) {
		t.Fatal("a noteworthy lock wait stayed at debug")
	}
	if !statsWorthInfo(healthy, healthy, statsInfoAtLeastEvery) {
		t.Fatal("the hourly heartbeat never fired — absence of the line becomes unreadable")
	}
}
