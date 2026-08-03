package state

// `link.json` — "has this agent ever been accepted, and if not, why not since".
//
// ⚠ IT EXISTS BECAUSE AN AGENT THAT IS INSTALLED AND CONNECTED TO NOTHING IS
// INVISIBLE FROM BOTH ENDS. The server has no row to show for a host that never
// arrived, and until this file the host could not answer either: the retry loop
// in internal/net had exactly one exit — a cancelled context — so it re-dialled
// forever whatever the answer was, and every fact about the answer was thrown
// away on the way past (the close code was formatted into a log string and the
// number discarded; an upgrade refused with 401/403 became the text "connect
// failed: …" with the status dropped). Nothing was left on disk to ask.
//
// So this is a breadcrumb in the same sense as update/marker.go's report.json:
// one small JSON file, written 0600 through a temp file and a rename, that a
// LATER run — or another command, which is the point here — reads. It is what
// makes `pdmux-agent instances` answerable OFFLINE, on the machine, with no
// dashboard and no credentials.
//
// ⚠ THE TOKEN IS NEVER IN IT, and that is not a matter of care. This file names
// the server and the host id so an operator can tell which dashboard a stray
// agent belongs to; both are already in the unit file and in the install output.
// The credential's only path stays HTTPS response → process → the 0600 config
// file, and a breadcrumb that copied it would put a second live copy in a
// directory whose whole purpose is to be read by other commands.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// LinkFile is the breadcrumb's name inside the instance's state directory.
const LinkFile = "link.json"

// Refusal is the last answer the server gave that was not "welcome".
type Refusal struct {
	// Code is what the agent could HONESTLY observe, not what it would like to
	// know. The vocabulary is internal/net's: the close codes it genuinely
	// receives map to themselves, and a 401 at the upgrade maps to the coarse
	// `refused`, because that answer is deliberately the same for a missing key,
	// an unknown one, a revoked one and an expired one.
	Code string `json:"code"`
	At   int64  `json:"at"`
}

// Link is the breadcrumb's contents.
type Link struct {
	Server string `json:"server"`
	// HostID is only knowable from a `welcome`, so it is also the proof that this
	// agent was accepted at least once.
	HostID string `json:"hostId,omitempty"`
	// LastConnectedAt is the last `welcome`, NOT the last successful dial. An open
	// socket is not acceptance — a server that upgrades and then closes on a bad
	// token would otherwise write this on every attempt, which is the same mistake
	// MarkHealthy exists to avoid in the retry counter.
	LastConnectedAt int64 `json:"lastConnectedAt"`
	// TokenExpiresAt is written only when the `welcome` frame carries it. The
	// contract is gaining that optional field separately; until a build is reading
	// a frame that has one the key is simply absent, because a zero here would
	// read as "this token expired at the epoch".
	TokenExpiresAt int64 `json:"tokenExpiresAt,omitempty"`
	// LastRefusal is kept ALONGSIDE LastConnectedAt rather than replacing it, and
	// a connection does not clear it. Both carry a timestamp, so the reader can
	// tell "refused, and never accepted since" from "refused once, fine now" —
	// clearing on connect would answer the second question by destroying the
	// evidence for the first.
	LastRefusal *Refusal `json:"lastRefusal,omitempty"`
}

// Connect is what a completed handshake tells the breadcrumb.
type Connect struct {
	Server string
	HostID string
	At     time.Time
	// TokenExpiresAt is 0 when the `welcome` frame did not carry one. This struct
	// is where that field lands when the contract grows it, so nothing else has to
	// move on the day it does.
	TokenExpiresAt int64
}

// RefusedSinceConnect reports whether the last thing that happened was a
// refusal. It is the question `instances` actually asks — "why is this agent not
// on a dashboard right now" — and it is a comparison rather than a flag so that
// no writer has to remember to clear anything.
func (l Link) RefusedSinceConnect() bool {
	return l.LastRefusal != nil && l.LastRefusal.At > l.LastConnectedAt
}

// ReadLink reads dir's breadcrumb. ok is false when there is none, which is the
// ordinary state of a host that has never run the agent — not an error.
func ReadLink(dir string) (Link, bool, error) {
	data, err := os.ReadFile(filepath.Join(dir, LinkFile))
	if errors.Is(err, os.ErrNotExist) {
		return Link{}, false, nil
	}
	if err != nil {
		return Link{}, false, err
	}
	var link Link
	if err := json.Unmarshal(data, &link); err != nil {
		return Link{}, false, err
	}
	return link, true, nil
}

// LinkStore writes one instance's breadcrumb.
//
// The mutex guards a read-modify-write: a connection and a refusal each update
// their own half of the file and must not drop the other's. Today both writers
// happen to be the same goroutine (the client's loop dispatches `welcome` in
// line and reports a refusal between sessions), but the file's invariant should
// not depend on a scheduling detail two packages away.
type LinkStore struct {
	dir string
	mu  sync.Mutex
}

// NewLinkStore records into dir, which is the instance's state directory.
func NewLinkStore(dir string) *LinkStore { return &LinkStore{dir: dir} }

// Dir is where this store writes, for a log line.
func (s *LinkStore) Dir() string { return s.dir }

// Read is ReadLink for this store's directory.
func (s *LinkStore) Read() (Link, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return ReadLink(s.dir)
}

// Connected records an accepted handshake.
func (s *LinkStore) Connected(c Connect) error {
	return s.update(func(link *Link) {
		link.Server = c.Server
		link.HostID = c.HostID
		link.LastConnectedAt = c.At.Unix()
		if c.TokenExpiresAt > 0 {
			link.TokenExpiresAt = c.TokenExpiresAt
		}
	})
}

// Refused records why the server would not take this agent.
func (s *LinkStore) Refused(server, code string, at time.Time) error {
	return s.update(func(link *Link) {
		if server != "" {
			// A refusal may be the FIRST thing that ever happens to a host, so this
			// is the only place the server address gets recorded for an agent that
			// was never accepted — which is exactly the agent this file is for.
			link.Server = server
		}
		link.LastRefusal = &Refusal{Code: code, At: at.Unix()}
	})
}

// update applies one change to the file, preserving everything it does not touch.
//
// A breadcrumb that cannot be read is REPLACED rather than treated as fatal: the
// same reasoning as EnsureDir's — losing this file costs the offline answer and
// nothing else, and refusing to write a new one would make a single corrupt file
// permanent.
func (s *LinkStore) update(mutate func(*Link)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	link, _, _ := ReadLink(s.dir)
	mutate(&link)
	data, err := json.Marshal(link)
	if err != nil {
		return err
	}
	return WriteFilePrivate(filepath.Join(s.dir, LinkFile), data)
}
