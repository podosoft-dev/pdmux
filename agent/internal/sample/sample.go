// Package sample keeps a bounded set of durations and answers percentiles over
// it, so a hot path can be measured without being slowed by the measuring.
//
// WHY PERCENTILES RATHER THAN A THRESHOLD: the agent already warns when one
// write or one lock wait crosses a fixed bar, and on the first real reproduction
// that bar reported NOTHING while a person watched their terminal lag. A
// threshold can only answer "was it worse than the number I guessed", and the
// number was guessed before anyone had a distribution to guess from. A summary
// answers "what is normal here", which is the question that was actually open —
// and it makes "slow, but nothing logged" impossible to reach.
//
// WHY BOUNDED: a busy pane emits dozens of frames a second, so an unbounded
// slice would grow with traffic exactly when traffic is the problem. Past the
// cap the values stop being kept but the count and the maximum keep moving, and
// Drain reports how many it actually held — a summary that quietly described a
// prefix of the interval would be worse than no summary.
package sample

import (
	"sort"
	"sync"
	"time"
)

// Set collects durations from any number of goroutines.
type Set struct {
	mu     sync.Mutex
	cap    int
	values []time.Duration
	count  int
	max    time.Duration
}

// Summary is one interval's worth of measurements.
type Summary struct {
	// Count is every observation, including those past the cap.
	Count int
	// Kept is how many were retained for the percentiles. Less than Count means
	// P50 and P95 describe the first Kept observations, not all of them.
	Kept int
	P50  time.Duration
	P95  time.Duration
	Max  time.Duration
}

// New builds a Set holding at most cap values; cap <= 0 uses a default.
func New(capacity int) *Set {
	if capacity <= 0 {
		capacity = 8192
	}
	return &Set{cap: capacity}
}

// Add records one observation.
//
// ⚠ THIS RUNS ON THE HOT PATH — a terminal pump calls it for every frame. It
// takes one uncontended mutex and appends; deliberately not an atomic-free
// design, because the alternative that avoids the lock (per-goroutine buffers
// merged later) buys nanoseconds on a path whose next step is a socket write.
func (s *Set) Add(value time.Duration) {
	s.mu.Lock()
	s.count++
	if value > s.max {
		s.max = value
	}
	if len(s.values) < s.cap {
		s.values = append(s.values, value)
	}
	s.mu.Unlock()
}

// Drain returns the interval's summary and starts a new interval.
//
// Reset here rather than in the caller so the read and the reset cannot be split
// by another Add — losing observations between the two would understate exactly
// the busy intervals worth reading.
func (s *Set) Drain() Summary {
	s.mu.Lock()
	values, count, max := s.values, s.count, s.max
	s.values, s.count, s.max = nil, 0, 0
	s.mu.Unlock()

	out := Summary{Count: count, Kept: len(values), Max: max}
	if len(values) == 0 {
		return out
	}
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	out.P50 = percentile(values, 0.50)
	out.P95 = percentile(values, 0.95)
	return out
}

// percentile indexes into an already-sorted slice. Nearest-rank, because the
// values are latencies read by a person deciding whether a hop is healthy, and
// an interpolated figure would report a duration that no write actually took.
func percentile(sorted []time.Duration, fraction float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	index := int(float64(len(sorted)) * fraction)
	if index >= len(sorted) {
		index = len(sorted) - 1
	}
	if index < 0 {
		index = 0
	}
	return sorted[index]
}
