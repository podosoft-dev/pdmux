package update

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/state"
)

// The rate limiter, and why a host needs one against its OWN server.
//
// Not abuse — a bug. A server that re-sends `update` on every reconnect, a
// dashboard row that never clears, a queue that retries a command it considers
// unacknowledged: each of those turns into a host that downloads an artifact,
// fails, restarts, downloads again, forever. That loop is expensive for the
// host, expensive for the server's bandwidth, and — worst — it looks like a
// working system from every dashboard, because the host is connected and busy.
//
// PER TARGET VERSION, so publishing a FIXED build is not blocked by the failures
// of the broken one. PERSISTED IN THE STATE DIRECTORY, because the loop we are
// bounding includes the agent restarting: an in-memory counter resets exactly
// when it matters.
const attemptsFile = "attempts.json"

type attemptLog struct {
	// Versions maps a target version to the unix seconds of recent attempts.
	Versions map[string][]int64 `json:"versions"`
}

// checkRate reports whether another attempt at version is allowed.
func checkRate(dir, version string, now time.Time, maxAttempts int, window time.Duration) error {
	recent := readAttempts(dir).recent(version, now, window)
	if len(recent) < maxAttempts {
		return nil
	}
	oldest := time.Unix(recent[0], 0)
	retryAt := oldest.Add(window)
	return refuse(CodeRateLimited, "%d attempts at %s in the last %s; not trying again until %s",
		len(recent), version, window, retryAt.UTC().Format(time.RFC3339))
}

// recordAttempt stamps an attempt and prunes what has aged out.
//
// It is called AFTER the refusals and under the cross-process lock: a refused
// frame is not an attempt (a server that corrects itself and re-sends must not
// find the host out of budget), and counting outside the lock would let two
// racing frames both read "2 so far".
func recordAttempt(dir, version string, now time.Time, maxAttempts int, window time.Duration) error {
	log := readAttempts(dir)
	recent := log.recent(version, now, window)
	if len(recent) >= maxAttempts {
		oldest := time.Unix(recent[0], 0)
		return refuse(CodeRateLimited, "%d attempts at %s in the last %s; not trying again until %s",
			len(recent), version, window, oldest.Add(window).UTC().Format(time.RFC3339))
	}
	if log.Versions == nil {
		log.Versions = map[string][]int64{}
	}
	log.Versions[version] = append(recent, now.Unix())
	// Every OTHER version is pruned to whatever is still inside the window, so the
	// file cannot grow without bound on a host that has seen many releases.
	for other := range log.Versions {
		if other == version {
			continue
		}
		if kept := log.recent(other, now, window); len(kept) > 0 {
			log.Versions[other] = kept
		} else {
			delete(log.Versions, other)
		}
	}
	data, err := json.Marshal(log)
	if err != nil {
		return refuse(CodeStateUnwritable, "cannot record the attempt: %v", err)
	}
	if err := state.WriteFilePrivate(filepath.Join(dir, attemptsFile), data); err != nil {
		// A state directory we cannot write is a Gate 2 we do not have — and this
		// is the cheapest place to find that out, before a download.
		return refuse(CodeStateUnwritable, "cannot record the attempt: %v", err)
	}
	return nil
}

func (l attemptLog) recent(version string, now time.Time, window time.Duration) []int64 {
	cutoff := now.Add(-window).Unix()
	var kept []int64
	for _, stamp := range l.Versions[version] {
		if stamp >= cutoff {
			kept = append(kept, stamp)
		}
	}
	return kept
}

// readAttempts never fails: a missing or corrupt log means "no attempts on
// record", which fails OPEN. That is the right direction for a limiter whose
// only job is to stop a runaway loop — a host that cannot read its own log must
// still be updatable, and the loop it is guarding against would rewrite the file
// on its first pass anyway.
func readAttempts(dir string) attemptLog {
	data, err := os.ReadFile(filepath.Join(dir, attemptsFile))
	if err != nil {
		return attemptLog{}
	}
	var log attemptLog
	if err := json.Unmarshal(data, &log); err != nil {
		return attemptLog{}
	}
	return log
}
