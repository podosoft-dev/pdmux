package sample

import (
	"sync"
	"testing"
	"time"
)

func ms(n int) time.Duration { return time.Duration(n) * time.Millisecond }

func TestSummarisesADistribution(t *testing.T) {
	set := New(0)
	// 1..100ms in, so the answers are arithmetic a reader can check by hand
	// rather than whatever the implementation happens to produce.
	for i := 1; i <= 100; i++ {
		set.Add(ms(i))
	}
	got := set.Drain()

	if got.Count != 100 || got.Kept != 100 {
		t.Fatalf("count/kept = %d/%d, want 100/100", got.Count, got.Kept)
	}
	if got.Max != ms(100) {
		t.Errorf("max = %v, want 100ms", got.Max)
	}
	// Nearest-rank on a sorted 1..100: index 50 is the 51st value, index 95 the 96th.
	if got.P50 != ms(51) {
		t.Errorf("p50 = %v, want 51ms", got.P50)
	}
	if got.P95 != ms(96) {
		t.Errorf("p95 = %v, want 96ms", got.P95)
	}
}

func TestDrainStartsAFreshInterval(t *testing.T) {
	set := New(0)
	set.Add(ms(5))
	set.Drain()

	got := set.Drain()
	if got.Count != 0 || got.Max != 0 || got.P50 != 0 {
		t.Fatalf("a drained set still reported %+v — the next interval would carry the last one's numbers", got)
	}
}

// ⚠ THE CAP MUST NOT BE ABLE TO LIE. Past the cap the values stop being kept,
// and if Count or Max were capped with them the summary would quietly describe
// only the start of a busy interval — understating exactly the intervals that
// are worth reading, which is the failure this whole measurement exists to avoid.
func TestCountAndMaxSurviveTheCap(t *testing.T) {
	set := New(10)
	for i := 1; i <= 100; i++ {
		set.Add(ms(i))
	}
	got := set.Drain()

	if got.Count != 100 {
		t.Errorf("count = %d, want 100 — observations past the cap must still be counted", got.Count)
	}
	if got.Kept != 10 {
		t.Errorf("kept = %d, want 10 — the cap is what bounds memory", got.Kept)
	}
	if got.Max != ms(100) {
		t.Errorf("max = %v, want 100ms — the largest value arrived past the cap", got.Max)
	}
}

func TestEmptySetIsAllZero(t *testing.T) {
	if got := New(0).Drain(); got.Count != 0 || got.Kept != 0 || got.Max != 0 {
		t.Fatalf("empty drain = %+v, want zeroes", got)
	}
}

// The hot path calls Add from every pane's pump at once; `go test -race` is what
// makes this assertion worth anything.
func TestConcurrentAddIsSafe(t *testing.T) {
	set := New(0)
	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 250; i++ {
				set.Add(ms(1))
			}
		}()
	}
	wg.Wait()

	if got := set.Drain(); got.Count != 2000 {
		t.Fatalf("count = %d, want 2000 — observations were lost under concurrency", got.Count)
	}
}
