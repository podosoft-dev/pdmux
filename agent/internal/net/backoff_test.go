package net

import (
	"testing"
	"time"
)

func TestBackoff(t *testing.T) {
	t.Run("[TC-PDAGENT-004] grows exponentially and stops at the cap", func(t *testing.T) {
		median := func(attempt int) time.Duration {
			return Delay(attempt, DefaultBackoff, func() float64 { return 0.5 })
		}
		want := []time.Duration{
			1 * time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second,
			16 * time.Second, 30 * time.Second, 30 * time.Second,
		}
		for index, expected := range want {
			if got := median(index + 1); got != expected {
				t.Fatalf("Delay(%d) = %v, want %v", index+1, got, expected)
			}
		}
	})

	t.Run("[TC-PDAGENT-005] jitters within +/-10% of the median delay", func(t *testing.T) {
		low := Delay(3, DefaultBackoff, func() float64 { return 0 })
		high := Delay(3, DefaultBackoff, func() float64 { return 1 })
		if low != 3600*time.Millisecond {
			t.Fatalf("floor = %v, want 3.6s", low)
		}
		if high != 4400*time.Millisecond {
			t.Fatalf("ceiling = %v, want 4.4s", high)
		}
	})

	t.Run("[TC-PDAGENT-004] treats attempt 0 as the first retry", func(t *testing.T) {
		// Nothing calls it with 0 today, but a caller that did would otherwise get
		// base/factor — a delay SHORTER than the first retry, which is the wrong
		// direction for the one value this file exists to keep large.
		if got := Delay(0, DefaultBackoff, func() float64 { return 0.5 }); got != time.Second {
			t.Fatalf("Delay(0) = %v, want the first-retry delay", got)
		}
	})

	t.Run("[TC-PDAGENT-004] a zero schedule is the default, not a tight loop", func(t *testing.T) {
		if got := Delay(1, Backoff{}, func() float64 { return 0.5 }); got != DefaultBackoff.Base {
			t.Fatalf("Delay with a zero Backoff = %v, want %v", got, DefaultBackoff.Base)
		}
	})
}
