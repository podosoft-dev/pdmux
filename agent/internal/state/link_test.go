package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The token this agent would be holding while it writes any of these. It is
// never passed to the store — the assertion is that no path through the store
// can put it in the file, which is the one thing this breadcrumb must never do.
const linkToken = "pdmxa-token-that-must-never-be-written"

// linked builds a store over a directory that belongs to the test and nothing
// else. The state directory of the machine running the specs is somebody's real
// agent's, and a spec that wrote into it would be editing a live host's history.
func linked(t *testing.T) *LinkStore {
	t.Helper()
	return NewLinkStore(filepath.Join(t.TempDir(), "pdmux"))
}

func TestLinkStore(t *testing.T) {
	accepted := time.Unix(1_785_000_000, 0)
	refused := time.Unix(1_785_009_000, 0)

	t.Run("[TC-PDAGENT-114] records a connection so the answer survives the process", func(t *testing.T) {
		store := linked(t)
		if _, ok, err := store.Read(); ok || err != nil {
			t.Fatalf("a host that never ran the agent must read as absent, not as an error: ok=%v err=%v", ok, err)
		}

		err := store.Connected(Connect{
			Server: "wss://pdmux.example.com/agent/ws",
			HostID: "host-abc",
			At:     accepted,
		})
		if err != nil {
			t.Fatal(err)
		}

		link, ok, err := store.Read()
		if err != nil || !ok {
			t.Fatalf("the breadcrumb did not survive the write: ok=%v err=%v", ok, err)
		}
		if link.HostID != "host-abc" || link.Server != "wss://pdmux.example.com/agent/ws" {
			t.Fatalf("link = %+v", link)
		}
		if link.LastConnectedAt != accepted.Unix() {
			t.Fatalf("lastConnectedAt = %d, want %d", link.LastConnectedAt, accepted.Unix())
		}
	})

	t.Run("[TC-PDAGENT-114] never writes the token, whatever it is handed", func(t *testing.T) {
		// ⚠ THE FILE IS READ BY OTHER COMMANDS BY DESIGN, so a credential in it is
		// a credential in whatever those print. The store has nowhere to put one —
		// this proves that stays true of every field it does write.
		store := linked(t)
		if err := store.Connected(Connect{Server: linkToken, HostID: "host-abc", At: accepted}); err != nil {
			t.Fatal(err)
		}
		if err := store.Refused(linkToken, "refused", refused); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(store.Dir(), LinkFile))
		if err != nil {
			t.Fatal(err)
		}
		var document map[string]any
		if err := json.Unmarshal(data, &document); err != nil {
			t.Fatal(err)
		}
		if _, present := document["token"]; present {
			t.Fatalf("the breadcrumb grew a token field:\n%s", data)
		}
		// The server field is the only one an operator fills in, so it is the only
		// place a mistake could put a credential — and it is echoed back verbatim.
		// Everything else must be free of it.
		delete(document, "server")
		rest, _ := json.Marshal(document)
		if strings.Contains(string(rest), linkToken) {
			t.Fatalf("a credential reached a field that is not the server address:\n%s", rest)
		}
	})

	t.Run("[TC-PDAGENT-114] a refusal does not erase the last acceptance, and vice versa", func(t *testing.T) {
		// Both timestamps are what makes "refused, and never accepted since"
		// distinguishable from "refused once, fine now". A writer that cleared the
		// other half would answer one question by destroying the other.
		store := linked(t)
		if err := store.Connected(Connect{Server: "wss://pdmux.example.com/agent/ws", HostID: "host-abc", At: accepted}); err != nil {
			t.Fatal(err)
		}
		if err := store.Refused("wss://pdmux.example.com/agent/ws", "token_revoked", refused); err != nil {
			t.Fatal(err)
		}

		link, _, err := store.Read()
		if err != nil {
			t.Fatal(err)
		}
		if link.LastConnectedAt != accepted.Unix() {
			t.Fatalf("the refusal erased the acceptance: %+v", link)
		}
		if link.HostID != "host-abc" {
			t.Fatalf("the refusal erased the host id: %+v", link)
		}
		if link.LastRefusal == nil || link.LastRefusal.Code != "token_revoked" || link.LastRefusal.At != refused.Unix() {
			t.Fatalf("lastRefusal = %+v", link.LastRefusal)
		}
		if !link.RefusedSinceConnect() {
			t.Fatal("a refusal after the last acceptance must read as 'not connected since'")
		}

		// And reconnecting must not erase the refusal either: the file keeps both
		// and the COMPARISON decides, so nothing has to remember to clear anything.
		if err := store.Connected(Connect{Server: "wss://pdmux.example.com/agent/ws", HostID: "host-abc", At: refused.Add(time.Minute)}); err != nil {
			t.Fatal(err)
		}
		link, _, err = store.Read()
		if err != nil {
			t.Fatal(err)
		}
		if link.LastRefusal == nil {
			t.Fatal("the reconnect deleted the refusal instead of outdating it")
		}
		if link.RefusedSinceConnect() {
			t.Fatal("a refusal older than the last acceptance still reads as current")
		}
	})

	t.Run("[TC-PDAGENT-114] records a refusal for an agent that was never accepted", func(t *testing.T) {
		// The case the whole file exists for: nothing has ever welcomed this agent,
		// so there is no host id and no server row anywhere — the refusal is the
		// only thing anybody can read.
		store := linked(t)
		if err := store.Refused("wss://pdmux.example.com/agent/ws", "host_deleted", refused); err != nil {
			t.Fatal(err)
		}
		link, ok, err := store.Read()
		if err != nil || !ok {
			t.Fatalf("ok=%v err=%v", ok, err)
		}
		if link.LastConnectedAt != 0 || link.HostID != "" {
			t.Fatalf("an agent that was never accepted claims it was: %+v", link)
		}
		if link.Server != "wss://pdmux.example.com/agent/ws" {
			t.Fatalf("the refusal did not record which server refused: %+v", link)
		}
		if !link.RefusedSinceConnect() {
			t.Fatal("never accepted plus a refusal must read as 'refused since'")
		}
	})

	t.Run("[TC-PDAGENT-114] leaves the file 0600 and no expiry key until a frame carries one", func(t *testing.T) {
		store := linked(t)
		if err := store.Connected(Connect{Server: "wss://pdmux.example.com/agent/ws", HostID: "host-abc", At: accepted}); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(filepath.Join(store.Dir(), LinkFile))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != FileMode {
			t.Fatalf("mode = %04o, want %04o", info.Mode().Perm(), FileMode)
		}

		data, err := os.ReadFile(filepath.Join(store.Dir(), LinkFile))
		if err != nil {
			t.Fatal(err)
		}
		var document map[string]any
		if err := json.Unmarshal(data, &document); err != nil {
			t.Fatal(err)
		}
		// A zero would read as "this token expired at the epoch", so the key stays
		// out until the welcome frame actually carries an expiry.
		if _, present := document["tokenExpiresAt"]; present {
			t.Fatalf("tokenExpiresAt was written without a frame to fill it:\n%s", data)
		}

		// And when a frame does carry one, it lands and survives a later refusal.
		if err := store.Connected(Connect{Server: "wss://pdmux.example.com/agent/ws", HostID: "host-abc", At: accepted, TokenExpiresAt: 1_790_000_000}); err != nil {
			t.Fatal(err)
		}
		if err := store.Refused("wss://pdmux.example.com/agent/ws", "refused", refused); err != nil {
			t.Fatal(err)
		}
		link, _, err := store.Read()
		if err != nil {
			t.Fatal(err)
		}
		if link.TokenExpiresAt != 1_790_000_000 {
			t.Fatalf("tokenExpiresAt = %d", link.TokenExpiresAt)
		}

		// ⚠ AND A NON-POSITIVE ONE IS REFUSED, WHICH IS NOT THE SAME AS ABSENT.
		// `time.Parse` on a value this build cannot read returns the ZERO time, and
		// its Unix() is -62135596800 — a number, not a nothing. Written through, it
		// would say the credential expired in year 1 and turn a healthy agent into
		// one `instances` reports as lapsed. The caller drops the field on a parse
		// error too; this is the layer that makes a mistake there survivable.
		zeroTimeUnix := time.Time{}.Unix()
		if err := store.Connected(Connect{
			Server: "wss://pdmux.example.com/agent/ws", HostID: "host-abc", At: accepted,
			TokenExpiresAt: zeroTimeUnix,
		}); err != nil {
			t.Fatal(err)
		}
		link, _, err = store.Read()
		if err != nil {
			t.Fatal(err)
		}
		if link.TokenExpiresAt != 1_790_000_000 {
			t.Fatalf("tokenExpiresAt = %d, want the real one kept rather than overwritten with %d",
				link.TokenExpiresAt, zeroTimeUnix)
		}
	})

	t.Run("[TC-PDAGENT-114] replaces a corrupt breadcrumb instead of failing forever", func(t *testing.T) {
		// A half-written file must cost the offline answer once, not permanently:
		// refusing to write over it would make one bad power cut final.
		store := linked(t)
		if err := EnsureDir(store.Dir()); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(store.Dir(), LinkFile), []byte("{not json"), FileMode); err != nil {
			t.Fatal(err)
		}
		if _, ok, err := store.Read(); ok || err == nil {
			t.Fatal("a corrupt breadcrumb must be reported, not returned as data")
		}
		if err := store.Connected(Connect{Server: "wss://pdmux.example.com/agent/ws", HostID: "host-abc", At: accepted}); err != nil {
			t.Fatal(err)
		}
		link, ok, err := store.Read()
		if err != nil || !ok || link.HostID != "host-abc" {
			t.Fatalf("the store did not recover from a corrupt file: %+v ok=%v err=%v", link, ok, err)
		}
	})
}
