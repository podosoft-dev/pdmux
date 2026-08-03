package git

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// A UUID-shaped host id, like the one the server hands out on `welcome`.
const testHostID = "11111111-2222-4333-8444-555555555555"

func TestAckedDetailLedger(t *testing.T) {
	fix := newFixture(t)
	ctx := context.Background()

	t.Run("[TC-PDAGENT-036] skips details the server acked, across a restart", func(t *testing.T) {
		stateDir := t.TempDir()

		first := NewDetailLedger(0, NewFileStore(stateDir))
		first.Adopt(testHostID)
		cold := CollectRepoSnapshot(ctx, SnapshotOptions{
			Path:         fix.Repo,
			Name:         "demo",
			Limit:        100,
			DetailBudget: 100,
			Ledger:       first,
		})
		if len(cold.Details) == 0 {
			t.Fatal("a cold ledger must produce details")
		}
		stored := []string{}
		for _, detail := range cold.Details {
			stored = append(stored, detail.Sha)
		}
		first.Ack(fix.Repo, stored)

		// A brand-new process: only the ACKED tier survives, and it is enough.
		restarted := NewDetailLedger(0, NewFileStore(stateDir))
		restarted.Adopt(testHostID)
		if got := restarted.AckedCount(fix.Repo); got != len(stored) {
			t.Fatalf("acked = %d, want %d", got, len(stored))
		}
		warm := CollectRepoSnapshot(ctx, SnapshotOptions{
			Path:         fix.Repo,
			Name:         "demo",
			Limit:        100,
			DetailBudget: 100,
			Ledger:       restarted,
		})
		if len(warm.Details) != 0 {
			t.Fatalf("a restarted agent rebuilt %d details the server already stored", len(warm.Details))
		}
		if warm.Pending != 0 {
			t.Fatalf("pending = %d", warm.Pending)
		}
	})

	t.Run("[TC-PDAGENT-036] never treats a merely-sent detail as stored", func(t *testing.T) {
		stateDir := t.TempDir()
		sent := NewDetailLedger(0, NewFileStore(stateDir))
		sent.Adopt(testHostID)
		sent.Record("/repo", "abcdef1234567")
		if !sent.Has("/repo", "abcdef1234567") {
			t.Fatal("the memory tier must skip a detail this process already produced")
		}
		if sent.Size("/repo") != 1 {
			t.Fatalf("size = %d", sent.Size("/repo"))
		}

		// A frame in flight when the socket dropped may never have been stored, so
		// the next process must rebuild it rather than leave the commit blank.
		restarted := NewDetailLedger(0, NewFileStore(stateDir))
		restarted.Adopt(testHostID)
		if restarted.Has("/repo", "abcdef1234567") {
			t.Fatal("a merely-sent detail survived a restart; that commit could stay blank forever")
		}
	})

	t.Run("[TC-PDAGENT-037] writes the ledger 0600 inside a 0700 state dir", func(t *testing.T) {
		// Nested, so the directory is one the store had to create itself.
		stateDir := filepath.Join(t.TempDir(), "nested")
		store := NewFileStore(stateDir)
		if err := store.Save(testHostID, Repos{"/repo": {"abcdef1234567"}}); err != nil {
			t.Fatalf("save: %v", err)
		}

		file := filepath.Join(stateDir, LedgerFileName(testHostID))
		info, err := os.Stat(file)
		if err != nil {
			t.Fatal(err)
		}
		// The ledger names repository paths on this machine, which is not
		// something to leave world-readable.
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Fatalf("ledger mode = %o, want 600", mode)
		}
		dir, err := os.Stat(stateDir)
		if err != nil {
			t.Fatal(err)
		}
		if mode := dir.Mode().Perm(); mode != 0o700 {
			t.Fatalf("state dir mode = %o, want 700", mode)
		}
		// A crash mid-write must leave the previous ledger, not a temp file.
		if _, err := os.Stat(file + ".tmp"); err == nil {
			t.Fatal("the temp file survived a successful save")
		}
		loaded := store.Load(testHostID)
		if len(loaded) != 1 || !equalStrings(loaded["/repo"], []string{"abcdef1234567"}) {
			t.Fatalf("loaded = %v", loaded)
		}
	})

	t.Run("[TC-PDAGENT-037] discards a ledger from another host or another layout", func(t *testing.T) {
		// The cost of rebuilding is bounded; the cost of a wrong skip is a blank
		// commit forever. So anything not unambiguously ours is thrown away.
		cases := map[string]string{
			"another host":   `{"v":1,"hostId":"other","repos":{"a":["x"]}}`,
			"another layout": `{"v":99,"hostId":"` + testHostID + `","repos":{"a":["x"]}}`,
			"truncated":      `{"v":1,"hostId":"` + testHostID + `","repos"`,
			"null":           `null`,
			"an array":       `[1,2,3]`,
			"no version":     `{"hostId":"` + testHostID + `","repos":{"a":["x"]}}`,
		}
		for name, text := range cases {
			if got := ParseLedger([]byte(text), testHostID); len(got) != 0 {
				t.Fatalf("%s parsed to %v, want nothing", name, got)
			}
		}

		// A repository whose entry is the wrong shape is skipped on its own; the
		// rest of the ledger is still worth having.
		mixed := ParseLedger([]byte(`{"v":1,"hostId":"`+testHostID+`","repos":{"/a":["x","y"],"/b":"not-an-array","/c":["ok",7,null]}}`), testHostID)
		if !equalStrings(mixed["/a"], []string{"x", "y"}) {
			t.Fatalf("/a = %v", mixed["/a"])
		}
		if _, present := mixed["/b"]; present {
			t.Fatalf("/b survived: %v", mixed["/b"])
		}
		if !equalStrings(mixed["/c"], []string{"ok"}) {
			t.Fatalf("/c = %v, want only the string entries", mixed["/c"])
		}
	})

	t.Run("[TC-PDAGENT-037] keeps a missing or unwritable ledger non-fatal", func(t *testing.T) {
		// A path whose parent is a file: the state dir can never be created here.
		store := NewFileStore(filepath.Join(os.DevNull, "pdmux"))
		if got := store.Load(testHostID); len(got) != 0 {
			t.Fatalf("load = %v, want nothing", got)
		}
		if store.Unavailable() {
			t.Fatal("a store that has not tried to write yet is not unavailable")
		}

		ledger := NewDetailLedger(0, store)
		ledger.Adopt(testHostID)
		ledger.Ack("/repo", []string{"abcdef1234567"}) // must not panic
		// The in-memory tier still works, so the pass is unaffected.
		if !ledger.Has("/repo", "abcdef1234567") {
			t.Fatal("an unwritable ledger must still remember within the process")
		}
		// And the operator gets told, rather than the agent retrying forever.
		if !store.Unavailable() {
			t.Fatal("a failed write must raise the state.unwritable condition")
		}
		if err := store.Save(testHostID, Repos{}); err != nil {
			t.Fatalf("a disabled store must stop trying, not keep failing: %v", err)
		}
	})

	t.Run("[TC-PDAGENT-037] keeps the file name inside the state directory", func(t *testing.T) {
		// The host id comes from the server. Even if it is ever less strict, the
		// name it produces may not escape the directory.
		if got := LedgerFileName("../../etc/passwd"); got != "details-______etc_passwd.json" {
			t.Fatalf("file name = %q", got)
		}
		if got := LedgerFileName(testHostID); got != "details-"+testHostID+".json" {
			t.Fatalf("file name = %q", got)
		}
	})

	t.Run("[TC-PDAGENT-036] forgets a repository in both tiers", func(t *testing.T) {
		ledger := NewDetailLedger(0, NewFileStore(t.TempDir()))
		ledger.Adopt(testHostID)
		ledger.Record("/repo", "abcdef1234567")
		ledger.Ack("/repo", []string{"1234567abcdef"})
		ledger.Forget("/repo")
		if ledger.Has("/repo", "abcdef1234567") || ledger.Has("/repo", "1234567abcdef") {
			t.Fatal("a forgotten repository must be gone from both tiers")
		}
	})

	t.Run("[TC-PDAGENT-036] adopting a different host drops the previous server's acks", func(t *testing.T) {
		store := NewFileStore(t.TempDir())
		ledger := NewDetailLedger(0, store)
		ledger.Adopt(testHostID)
		ledger.Ack("/repo", []string{"abcdef1234567"})
		// A different host id is a different server's memory; keeping the acks
		// would skip details THIS server has never seen.
		ledger.Adopt("99999999-2222-4333-8444-555555555555")
		if ledger.AckedCount("/repo") != 0 {
			t.Fatal("acks from another host survived adoption")
		}
	})
}

// UNTAGGED: no requirement asserts the per-repo cap or its eviction order, so this
// spec carries no TC id rather than an invented one.
func TestLedgerPerRepoCap(t *testing.T) {
	t.Run("sheds the oldest shas once the per-repo cap is reached", func(t *testing.T) {
		ledger := NewDetailLedger(3, nil)
		for index := 0; index < 5; index++ {
			ledger.Record("/repo", "sha"+strconv.Itoa(index))
		}
		if got := ledger.Size("/repo"); got != 3 {
			t.Fatalf("size = %d, want the cap of 3", got)
		}
		// The oldest entries are shed first — they are also the commits nobody is
		// about to click.
		for _, gone := range []string{"sha0", "sha1"} {
			if ledger.Has("/repo", gone) {
				t.Fatalf("%s survived the cap", gone)
			}
		}
		for _, kept := range []string{"sha2", "sha3", "sha4"} {
			if !ledger.Has("/repo", kept) {
				t.Fatalf("%s was evicted before the older entries", kept)
			}
		}
	})
}

// UNTAGGED: the TypeScript ledger ran on one event loop, so no TC covers
// concurrent access. In Go a `detailAck` and a running git pass are two
// goroutines on the same maps, and the runtime turns that into a fatal
// "concurrent map writes" — which is what this exercises even without -race.
func TestLedgerIsSafeUnderConcurrency(t *testing.T) {
	t.Run("survives acks arriving while a pass is recording", func(t *testing.T) {
		ledger := NewDetailLedger(0, NewFileStore(t.TempDir()))
		ledger.Adopt(testHostID)

		done := make(chan struct{})
		go func() {
			defer close(done)
			for index := 0; index < 200; index++ {
				ledger.Ack("/repo", []string{"acked" + strconv.Itoa(index)})
			}
		}()
		for index := 0; index < 200; index++ {
			ledger.Record("/repo", "sent"+strconv.Itoa(index))
			ledger.Has("/repo", "sent"+strconv.Itoa(index))
		}
		<-done

		if ledger.Size("/repo") != 200 || ledger.AckedCount("/repo") != 200 {
			t.Fatalf("sent = %d, acked = %d", ledger.Size("/repo"), ledger.AckedCount("/repo"))
		}
	})
}

// UNTAGGED: nothing in the traceability matrix pins the ledger's file FORMAT;
// TC-PDAGENT-037 covers its modes and its rejection rules.
func TestLedgerFileShape(t *testing.T) {
	t.Run("writes a document ParseLedger accepts, with no null map", func(t *testing.T) {
		stateDir := t.TempDir()
		store := NewFileStore(stateDir)
		if err := store.Save(testHostID, nil); err != nil {
			t.Fatalf("save: %v", err)
		}
		data, err := os.ReadFile(filepath.Join(stateDir, LedgerFileName(testHostID)))
		if err != nil {
			t.Fatal(err)
		}
		var document struct {
			V     int             `json:"v"`
			Host  string          `json:"hostId"`
			Repos json.RawMessage `json:"repos"`
		}
		if err := json.Unmarshal(data, &document); err != nil {
			t.Fatalf("the ledger we wrote does not parse: %v", err)
		}
		if document.V != LedgerVersion || document.Host != testHostID {
			t.Fatalf("document = %+v", document)
		}
		// A nil Go map marshals to `null`, which ParseLedger would then reject —
		// the ledger would silently stop working after the first empty save.
		if string(document.Repos) != "{}" {
			t.Fatalf("repos = %s, want {}", document.Repos)
		}
	})
}
