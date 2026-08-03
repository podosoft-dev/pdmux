package git

import "sync"

// DefaultPerRepoCap bounds how many shas one repository may keep in either tier.
const DefaultPerRepoCap = 5_000

// DetailLedger tracks which commit details are already accounted for — in two
// tiers.
//
//	SENT  (memory)  — produced by this process. Skipping them is only safe while
//	                  the connection that carried them is alive, so this tier
//	                  dies with the process.
//	ACKED (disk)    — the server said `detailAck`, so it HAS them. This tier
//	                  survives a restart, which is what stops a restarted agent
//	                  spending its whole budget rebuilding immutable patches the
//	                  server already stored (300 `git show` calls per repo).
//
// Keeping them separate is deliberate: a frame in flight when the socket dropped
// may never have been stored, and treating "I sent it once" as "it exists" would
// leave that commit permanently blank in the UI.
//
// Every method is safe to call from more than one goroutine. Node's event loop
// serialised a `detailAck` against a running git pass for free; in Go those are
// two goroutines touching the same maps.
type DetailLedger struct {
	mu         sync.Mutex
	sent       map[string]*shaSet
	acked      map[string]*shaSet
	hostID     string
	perRepoCap int
	store      Store
}

// NewDetailLedger builds a ledger. perRepoCap <= 0 means DefaultPerRepoCap; a
// nil store keeps the ledger memory-only, which is exactly what a restart then
// costs.
func NewDetailLedger(perRepoCap int, store Store) *DetailLedger {
	if perRepoCap <= 0 {
		perRepoCap = DefaultPerRepoCap
	}
	return &DetailLedger{
		sent:       map[string]*shaSet{},
		acked:      map[string]*shaSet{},
		perRepoCap: perRepoCap,
		store:      store,
	}
}

// Adopt loads what this host's server already acknowledged. Called on `welcome`.
func (l *DetailLedger) Adopt(hostID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.hostID == hostID {
		return
	}
	l.hostID = hostID
	// A different host id means a different server's memory; keeping the old
	// acks would skip details THIS server has never seen.
	l.acked = map[string]*shaSet{}
	if l.store == nil {
		return
	}
	for repo, shas := range l.store.Load(hostID) {
		set := newShaSet()
		for _, sha := range shas {
			set.add(sha, l.perRepoCap)
		}
		l.acked[repo] = set
	}
}

// Has reports whether the detail for this sha is accounted for in either tier.
func (l *DetailLedger) Has(repo, sha string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sent[repo].has(sha) || l.acked[repo].has(sha)
}

// Record notes that this process produced the detail (memory tier).
func (l *DetailLedger) Record(repo, sha string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	addTo(l.sent, repo, sha, l.perRepoCap)
}

// Ack notes that the server confirmed it stored these (disk tier).
func (l *DetailLedger) Ack(repo string, shas []string) {
	if len(shas) == 0 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, sha := range shas {
		addTo(l.acked, repo, sha, l.perRepoCap)
	}
	l.persist()
}

// AckedCount is how many shas the server has confirmed for this repository.
func (l *DetailLedger) AckedCount(repo string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.acked[repo].len()
}

// Size is how many details this process has produced for this repository.
func (l *DetailLedger) Size(repo string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sent[repo].len()
}

// Forget drops both tiers for one repository — a checkout that is gone.
func (l *DetailLedger) Forget(repo string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.sent, repo)
	delete(l.acked, repo)
	l.persist()
}

// persist writes the acked tier out synchronously. Acks are rare (one per repo
// per server store) and a few KB each, so a debounce timer would only add a way
// to lose the write in a crash.
//
// Caller holds l.mu.
func (l *DetailLedger) persist() {
	if l.store == nil || l.hostID == "" {
		return
	}
	repos := Repos{}
	for repo, set := range l.acked {
		repos[repo] = set.list()
	}
	// A ledger that cannot be written costs re-computation, never a pass; the
	// store remembers the failure and the heartbeat reports it as
	// `state.unwritable`.
	_ = l.store.Save(l.hostID, repos)
}

// shaSet is a set that remembers insertion order, because the cap has to shed
// the OLDEST entries — which are also the commits nobody is about to click.
type shaSet struct {
	members map[string]struct{}
	order   []string
}

func newShaSet() *shaSet {
	return &shaSet{members: map[string]struct{}{}}
}

// has is nil-safe so a lookup for an unknown repository needs no guard.
func (s *shaSet) has(sha string) bool {
	if s == nil {
		return false
	}
	_, ok := s.members[sha]
	return ok
}

func (s *shaSet) len() int {
	if s == nil {
		return 0
	}
	return len(s.members)
}

func (s *shaSet) list() []string {
	if s == nil {
		return []string{}
	}
	out := make([]string, len(s.order))
	copy(out, s.order)
	return out
}

func (s *shaSet) add(sha string, limit int) {
	if _, exists := s.members[sha]; exists {
		// Re-adding does not refresh the position: the entry is as old as the
		// first time it was seen, which is what "shed the oldest" has to mean.
		return
	}
	s.members[sha] = struct{}{}
	s.order = append(s.order, sha)
	for len(s.order) > limit {
		delete(s.members, s.order[0])
		s.order = s.order[1:]
	}
}

func addTo(sets map[string]*shaSet, repo, sha string, limit int) {
	set := sets[repo]
	if set == nil {
		set = newShaSet()
		sets[repo] = set
	}
	set.add(sha, limit)
}
