package collect

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

func portsOf(listeners []protocol.Listener) []int {
	out := make([]int, 0, len(listeners))
	for _, item := range listeners {
		out = append(out, item.Port)
	}
	return out
}

func findListener(listeners []protocol.Listener, port int) (protocol.Listener, bool) {
	for _, item := range listeners {
		if item.Port == port {
			return item, true
		}
	}
	return protocol.Listener{}, false
}

func TestParseLsofFields(t *testing.T) {
	t.Run("[TC-PDAGENT-119] reads the names the table format destroys", func(t *testing.T) {
		// ⚠ BOTH OF THESE WERE MEASURED ON THIS MACHINE, and both are why the
		// reader asks for `-F cn +c 0` instead of splitting lsof's columns:
		// `ControlCenter` is thirteen characters and the table truncates COMMAND
		// to nine, and `Google Chrome` contains a space that shifts every later
		// column so the address is read out of the wrong field.
		text := strings.Join([]string{
			"p1304", "cControlCenter", "f11", "n*:5000",
			"p5510", "cGoogle Chrome", "f45", "n127.0.0.1:9222",
		}, "\n")

		listeners, dropped := parseLsofFields(text).result()
		if dropped != 0 {
			t.Fatalf("dropped %d", dropped)
		}
		control, ok := findListener(listeners, 5000)
		if !ok || control.Process != "ControlCenter" {
			t.Fatalf("5000 = %+v, want the full thirteen-character name", control)
		}
		chrome, ok := findListener(listeners, 9222)
		if !ok || chrome.Process != "Google Chrome" {
			t.Fatalf("9222 = %+v, want the name with its space intact", chrome)
		}
	})

	t.Run("[TC-PDAGENT-119] a process with no command line is nameless, not mislabelled", func(t *testing.T) {
		// A `p` section with no `c` after it must not inherit the previous
		// process's name — a row naming the wrong process is worse than one
		// naming none, because nothing on screen says it is a guess.
		text := strings.Join([]string{
			"p100", "cpostgres", "f3", "n127.0.0.1:5432",
			"p200", "f4", "n127.0.0.1:6379",
		}, "\n")

		listeners, _ := parseLsofFields(text).result()
		if entry, _ := findListener(listeners, 6379); entry.Process != "" {
			t.Fatalf("6379 took the previous section's name: %q", entry.Process)
		}
		if entry, _ := findListener(listeners, 5432); entry.Process != "postgres" {
			t.Fatalf("5432 = %q, want postgres", entry.Process)
		}
	})

	t.Run("[TC-PDAGENT-119] one port bound several ways is one row", func(t *testing.T) {
		// A dual-stack service listens twice and is one thing to a person. And
		// ⚠ THE FLAG MUST FOLLOW THE MOST EXPOSED BINDING: 4000 is on loopback
		// AND on every interface, so it is reachable from off the host and
		// calling it loopback-only would understate exactly what a later
		// forwarding decision turns on.
		text := strings.Join([]string{
			"p100", "cnode", "f3", "n127.0.0.1:4000", "f4", "n*:4000",
			"p200", "cvite", "f5", "n127.0.0.1:5173", "f6", "n[::1]:5173",
		}, "\n")

		listeners, _ := parseLsofFields(text).result()
		if got := portsOf(listeners); len(got) != 2 {
			t.Fatalf("ports = %v, want one row per port", got)
		}
		both, _ := findListener(listeners, 4000)
		if both.LoopbackOnly {
			t.Fatal("4000 is also bound to every interface but reads as loopback-only")
		}
		loopback, _ := findListener(listeners, 5173)
		if !loopback.LoopbackOnly {
			t.Fatal("5173 is bound to 127.0.0.1 and ::1 only, but does not read as loopback-only")
		}
	})

	t.Run("[TC-PDAGENT-119] rows that are not an address are dropped, not reported as port 0", func(t *testing.T) {
		text := strings.Join([]string{
			"p100", "cnode", "f3", "n*:*", "f4", "n/tmp/some.sock", "f5", "n127.0.0.1:99999", "f6", "n127.0.0.1:0",
		}, "\n")
		listeners, _ := parseLsofFields(text).result()
		if len(listeners) != 0 {
			t.Fatalf("accepted a non-address: %+v", listeners)
		}
	})
}

func TestParseProcAddressByteOrder(t *testing.T) {
	// ⚠ THIS IS THE ONE THAT LOOKS RIGHT WHEN IT IS BACKWARDS. /proc prints each
	// 32-bit word in HOST byte order, so `0100007F` is 127.0.0.1 — read as plain
	// big-endian hex it is 1.0.0.127, which is not loopback and which no assertion
	// about a port number would ever notice.
	//
	// Both directions are asserted deliberately: the second row is the byte-swapped
	// twin of the first, so an implementation with the order reversed fails here
	// rather than passing by symmetry.
	t.Run("[TC-PDAGENT-120] decodes the kernel's word order in both directions", func(t *testing.T) {
		cases := []struct {
			address  string
			port     int
			loopback bool
			what     string
		}{
			{"0100007F:1389", 5001, true, "127.0.0.1"},
			{"7F000001:138A", 5002, false, "1.0.0.127 — the byte-swapped twin, and NOT loopback"},
			{"00000000:138B", 5003, false, "0.0.0.0, every interface"},
			{"00000000000000000000000001000000:1F90", 8080, true, "::1"},
			{"00000000000000000000000000000000:1F91", 8081, false, "::"},
		}
		for _, item := range cases {
			port, loopback, ok := parseProcAddress(item.address)
			if !ok {
				t.Fatalf("%s (%s) did not parse", item.address, item.what)
			}
			if port != item.port || loopback != item.loopback {
				t.Fatalf("%s (%s) = port %d loopback %v, want port %d loopback %v",
					item.address, item.what, port, loopback, item.port, item.loopback)
			}
		}
	})

	t.Run("[TC-PDAGENT-120] refuses a hex address that is not a whole number of words", func(t *testing.T) {
		for _, address := range []string{"0100007:1389", "zzzzzzzz:1389", ":1389", "0100007F:zzzz", "0100007F"} {
			if _, _, ok := parseProcAddress(address); ok {
				t.Fatalf("accepted %q", address)
			}
		}
	})
}

// writeProcFixture builds the parts of /proc this reader touches: the two
// listening tables and, for one process, the file descriptor that owns a socket.
func writeProcFixture(t *testing.T, tcp string, tcp6 string, pid string, inode string, comm string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "net", "tcp"), []byte(tcp), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "net", "tcp6"), []byte(tcp6), 0o644); err != nil {
		t.Fatal(err)
	}
	if pid != "" {
		fdDir := filepath.Join(root, pid, "fd")
		if err := os.MkdirAll(fdDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, pid, "comm"), []byte(comm+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		// The socket descriptor is a symlink to `socket:[inode]`; the inode is the
		// only handle /proc/net/tcp offers towards a process.
		if err := os.Symlink("socket:["+inode+"]", filepath.Join(fdDir, "7")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("/dev/null", filepath.Join(fdDir, "1")); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

const procHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

func TestReadListenersProc(t *testing.T) {
	t.Run("[TC-PDAGENT-120] reads both families and names the process behind a port", func(t *testing.T) {
		tcp := procHeader +
			"   0: 0100007F:1389 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99001 1 0 100 0 0 10 0\n" +
			// Not listening (state 01 = ESTABLISHED) — an established connection is
			// not a service, and listing one invites somebody to forward a socket
			// that closes the moment its peer goes away.
			"   1: 00000000:138A 0100007F:C000 01 00000000:00000000 00:00000000 00000000  1000        0 99002 1 0 100 0 0 10 0\n"
		tcp6 := procHeader +
			"   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99003 1 0 100 0 0 10 0\n"

		root := writeProcFixture(t, tcp, tcp6, "4242", "99001", "vite")
		previous := procNetRoot
		procNetRoot = root
		defer func() { procNetRoot = previous }()

		reading := readListenersProc()
		if !reading.Supported {
			t.Fatal("a readable /proc reported as unsupported")
		}
		if got, want := portsOf(reading.Listeners), []int{5001, 8080}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
			t.Fatalf("ports = %v, want %v (the established row must not appear)", got, want)
		}
		web, _ := findListener(reading.Listeners, 5001)
		if web.Process != "vite" {
			t.Fatalf("5001 process = %q, want the name from /proc/<pid>/comm", web.Process)
		}
		if !web.LoopbackOnly {
			t.Fatal("5001 is bound to 127.0.0.1 and does not read as loopback-only")
		}
		// The IPv6 row's inode belongs to no process in the fixture. A port whose
		// owner cannot be reached keeps its row and loses only the name.
		v6, _ := findListener(reading.Listeners, 8080)
		if v6.Process != "" {
			t.Fatalf("8080 process = %q, want empty — nothing in the fixture owns it", v6.Process)
		}
	})

	t.Run("[TC-PDAGENT-121] no /proc is 'we could not look', not 'nothing is listening'", func(t *testing.T) {
		// ⚠ THE WHOLE POINT OF Supported. Both cases produce an empty list, and a
		// screen that renders them identically tells an operator their host is
		// quiet when the truth is that nothing was measured.
		previous := procNetRoot
		procNetRoot = filepath.Join(t.TempDir(), "absent")
		defer func() { procNetRoot = previous }()

		reading := readListenersProc()
		if reading.Supported {
			t.Fatal("an unreadable /proc reported as supported")
		}
		if len(reading.Listeners) != 0 {
			t.Fatalf("listeners = %+v, want none", reading.Listeners)
		}
	})
}

func TestReadListenersLsofMissing(t *testing.T) {
	t.Run("[TC-PDAGENT-121] a host without the tool says so instead of reporting zero", func(t *testing.T) {
		// ⚠ THE SEAM EXISTS BECAUSE CLEARING PATH IS NOT ENOUGH. ResolveBinary also
		// searches absolute system prefixes, so a spec that only emptied PATH would
		// find this machine's real lsof and pass by measuring the host rather than
		// by exercising the case it names. sessions.go carries the same seam for
		// the same reason, after that false pass happened there.
		//
		// ⚠ A BARE NAME, NOT AN ABSOLUTE PATH — this is what production actually
		// hands over. ResolveBinary returns the name unchanged when it resolves
		// nowhere, and `NotFound` is set by the PATH lookup failing; an absolute
		// path that does not exist fails differently (a plain exec error), so
		// staging it that way would test a case the agent never reaches.
		previous := resolveLsof
		resolveLsof = func() string { return "pdmux-no-such-lsof" }
		defer func() { resolveLsof = previous }()

		reading := readListenersLsof(context.Background(), 500)
		if reading.Supported {
			t.Fatal("a missing lsof reported as supported")
		}
		if reading.Listeners == nil {
			t.Fatal("listeners is nil; a nil slice marshals to null and fails the frame")
		}
	})
}

func TestReadListenersOnThisHost(t *testing.T) {
	// ⚠ THIS IS THE ONLY SPEC THAT PROVES THE darwin INVOCATION. Everything above
	// feeds a parser text that a person wrote; nothing above would notice if the
	// flags were wrong, if `+c 0` were unsupported, or if lsof were invoked in a
	// way that returns no rows. It runs on macOS and is skipped everywhere else,
	// so a green suite on linux or in CI says nothing whatsoever about this path.
	if runtime.GOOS != "darwin" {
		t.Skip("the lsof path only exists on darwin; linux reads /proc, covered above")
	}
	t.Run("[TC-PDAGENT-123] reads this machine's real listening ports", func(t *testing.T) {
		reading := ReadListeners(context.Background(), defaultListenerTimeoutMs)
		if !reading.Supported {
			t.Fatal("this Mac has lsof; the reader failed to find or run it")
		}
		// An empty list on a developer's machine means the flags stopped selecting
		// anything, which is exactly the regression this spec exists to catch.
		if len(reading.Listeners) == 0 {
			t.Fatal("no listening ports found on this host; the lsof arguments no longer select anything")
		}
		named := 0
		for _, item := range reading.Listeners {
			if item.Port < 1 || item.Port > 65535 {
				t.Fatalf("port out of range: %+v", item)
			}
			if item.Process != "" {
				named++
			}
		}
		// Field output exists so the name survives; if none arrived, `-F cn` is not
		// being parsed even though the ports are.
		if named == 0 {
			t.Fatal("every port came back nameless; the -F field output is not being read")
		}
		t.Logf("%d ports, %d named", len(reading.Listeners), named)
	})
}

func TestListenerCap(t *testing.T) {
	t.Run("[TC-PDAGENT-121] truncates to the contract's cap and says how many it left", func(t *testing.T) {
		// ⚠ THE CAP IS A REJECTION IN THE CONTRACT: one entry over it fails the
		// whole heartbeat, taking the resource bars and the session list with it.
		// Truncating keeps the host visible — and Dropped is what stops the
		// shortened list from reading as the complete one.
		acc := newListenerAccumulator()
		for port := 1000; port < 1000+MaxListeners+7; port++ {
			acc.add(port, "node", true)
		}
		listeners, dropped := acc.result()
		if len(listeners) != MaxListeners {
			t.Fatalf("kept %d, want %d", len(listeners), MaxListeners)
		}
		if dropped != 7 {
			t.Fatalf("dropped = %d, want 7", dropped)
		}
		// Sorted, so the table does not reshuffle between beats and read as activity.
		for index := 1; index < len(listeners); index++ {
			if listeners[index-1].Port >= listeners[index].Port {
				t.Fatalf("not sorted at %d: %v", index, portsOf(listeners))
			}
		}
	})

	t.Run("[TC-PDAGENT-121] clips a process name rather than losing the frame", func(t *testing.T) {
		acc := newListenerAccumulator()
		acc.add(5001, strings.Repeat("n", listenerProcessMax+40), true)
		listeners, _ := acc.result()
		if got := len([]rune(listeners[0].Process)); got != listenerProcessMax {
			t.Fatalf("name length = %d, want %d", got, listenerProcessMax)
		}
	})
}

func TestCachedListeners(t *testing.T) {
	t.Run("[TC-PDAGENT-122] the reading is reused, so a beat does not spawn a process", func(t *testing.T) {
		// ⚠ THIS IS THE COST RULE, NOT AN OPTIMISATION. Reading this costs a
		// spawned lsof on darwin and a /proc/<pid>/fd walk on linux, and the
		// heartbeat runs every few seconds — the same shape the usage track was
		// rewritten to remove (docs/USAGE-COLLECTION.md §1).
		calls := 0
		clock := int64(1_000)
		read := NewCachedListeners(func(context.Context) ListenerReading {
			calls++
			return ListenerReading{Listeners: []protocol.Listener{}, Supported: true}
		}, 60, func() int64 { return clock })

		for beat := 0; beat < 12; beat++ {
			read(context.Background())
			clock += 5
		}
		if calls != 1 {
			t.Fatalf("read the host %d times in one TTL, want 1", calls)
		}

		clock += 60
		read(context.Background())
		if calls != 2 {
			t.Fatalf("read %d times after the TTL expired, want 2", calls)
		}
	})

	t.Run("[TC-PDAGENT-122] an unsupported host is cached too", func(t *testing.T) {
		// A host does not grow lsof between two beats, and re-deciding that every
		// five seconds is the cost this cache exists to avoid.
		calls := 0
		read := NewCachedListeners(func(context.Context) ListenerReading {
			calls++
			return ListenerReading{Listeners: []protocol.Listener{}, Supported: false}
		}, 60, func() int64 { return 1_000 })

		read(context.Background())
		read(context.Background())
		if calls != 1 {
			t.Fatalf("re-probed a host that has no tool: %d calls", calls)
		}
	})
}

func TestHeartbeatAlwaysReportsWhetherItLooked(t *testing.T) {
	// ⚠ THE BUG THIS EXISTS FOR, MEASURED ON A REAL HOST. The server parses every
	// frame through the contract before storing it, so a `.default([])` on this
	// field filled the absence in and a host running a pre-listeners agent was
	// stored with `listeners: []`. The dashboard then told its owner "nothing is
	// listening on this host" — a claim no agent had made. The contract now leaves
	// the field absent, which puts the burden here: THIS agent must always send
	// the key, or its honest "I found none" becomes indistinguishable from an old
	// agent's silence.
	marshal := func(t *testing.T, reading ListenerReading) string {
		t.Helper()
		beat := Heartbeat(t.Context(), testConfig(nil, nil), Deps{
			Resource:  quietReaders(),
			Sessions:  func(context.Context) SessionReading { return SessionReading{Present: true} },
			Listeners: func(context.Context) ListenerReading { return reading },
			Now:       func() int64 { return 1_785_000_000 },
		})
		raw, err := json.Marshal(beat)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}

	t.Run("[TC-PDAGENT-124] finding nothing still sends the key", func(t *testing.T) {
		got := marshal(t, ListenerReading{Listeners: []protocol.Listener{}, Supported: true})
		if !strings.Contains(got, `"listeners":[]`) {
			t.Fatalf("an empty result did not travel as an empty array:\n%s", got)
		}
	})

	t.Run("[TC-PDAGENT-124] a host that cannot look also sends the key", func(t *testing.T) {
		// Still `[]`, because the agent DID answer — what it could not do is say
		// more, and that is what the `listeners.unavailable` diagnostic is for.
		// Omitting the key here would blame this agent's age instead.
		got := marshal(t, ListenerReading{Listeners: []protocol.Listener{}, Supported: false})
		if !strings.Contains(got, `"listeners":[]`) {
			t.Fatalf("an unsupported host omitted the key:\n%s", got)
		}
	})

	t.Run("[TC-PDAGENT-124] a collector that panicked still sends the key", func(t *testing.T) {
		got := marshal(t, ListenerReading{})
		if !strings.Contains(got, `"listeners":[]`) {
			t.Fatalf("a nil reading marshalled as null or was omitted:\n%s", got)
		}
	})
}
