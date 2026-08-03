package net

// Reconnect backoff: exponential, jittered, capped.
//
// WHY JITTER IS NOT OPTIONAL: every agent on the fleet loses its socket at the
// same instant when the server restarts, and a jitter-free schedule makes them
// all dial again on the same second — the retry storm keeps the server down that
// it was trying to come back from.
//
// Ported from apps/agent/src/net/backoff.ts. The numbers, the centring and the
// rounding are the TypeScript's, so both agents in the field retry on the same
// schedule: the delay is computed in whole milliseconds for that reason, even
// though the result is a time.Duration.

import (
	"math"
	"math/rand/v2"
	"time"
)

// Backoff is the retry schedule. The zero value means DefaultBackoff, so a
// caller that does not care about retry timing can leave the field out.
type Backoff struct {
	// Base is the delay before the first retry.
	Base time.Duration
	// Max is the ceiling — a host that has been offline for an hour still retries this often.
	Max    time.Duration
	Factor float64
	// Jitter is the fraction of the delay that is randomised, 0..1 (0.2 = +/-10%).
	Jitter float64
}

// DefaultBackoff is what the agent runs with unless a caller says otherwise.
var DefaultBackoff = Backoff{
	Base:   time.Second,
	Max:    30 * time.Second,
	Factor: 2,
	Jitter: 0.2,
}

// DefaultTerminalMax is the ceiling used after a refusal that retrying cannot
// fix — a deleted host, a revoked token, an upgrade the server said no to.
//
// ⚠ IT IS A SEPARATE NUMBER RATHER THAN A CHANGE TO DefaultBackoff, for two
// reasons. The schedule above is the TypeScript's and both agents in the field
// have to retry a transient outage on the same one; and thirty seconds is right
// for an outage precisely because it is short. It is wrong for the other case:
// an agent whose host row was deleted kept dialling twice a minute forever, and
// on a fleet that is a permanent load nobody can see the reason for.
//
// Fifteen minutes is chosen against the recovery it delays, not against the
// traffic it saves: the answer needs a person (re-enable the host, install a new
// token), so the agent is waiting on somebody who will take longer than that,
// and it never gives up — see Reason.Terminal.
const DefaultTerminalMax = 15 * time.Minute

// withDefaults fills a partially specified schedule. A Base or Factor of zero
// would retry in a tight loop, which is the one failure mode this whole file
// exists to prevent, so absence means "the default" rather than "immediately".
func (b Backoff) withDefaults() Backoff {
	if b.Base <= 0 {
		b.Base = DefaultBackoff.Base
	}
	if b.Max <= 0 {
		b.Max = DefaultBackoff.Max
	}
	if b.Factor <= 0 {
		b.Factor = DefaultBackoff.Factor
	}
	if b.Jitter < 0 {
		b.Jitter = 0
	}
	return b
}

// Delay is how long to wait before retry number attempt (1 = the first retry
// after a drop). random is injected so a spec can assert an exact sequence; nil
// uses the process source.
func Delay(attempt int, options Backoff, random func() float64) time.Duration {
	if random == nil {
		random = rand.Float64
	}
	options = options.withDefaults()
	step := attempt
	if step < 1 {
		step = 1
	}
	baseMillis := float64(options.Base) / float64(time.Millisecond)
	maxMillis := float64(options.Max) / float64(time.Millisecond)
	raw := math.Min(maxMillis, baseMillis*math.Pow(options.Factor, float64(step-1)))
	spread := options.Jitter * raw
	// Centred on raw, so the median schedule is exactly the exponential one.
	millis := math.Round(raw - spread/2 + spread*random())
	if millis < 0 {
		millis = 0
	}
	return time.Duration(millis) * time.Millisecond
}
