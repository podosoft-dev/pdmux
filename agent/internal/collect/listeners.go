package collect

// TCP ports the host is currently listening on.
//
// WHY THIS IS NOT A PROBE. probe.go answers "is the port the server asked about
// up"; this answers "what is here that nobody has registered yet". The point is
// to spare somebody an ssh and an `lsof` before they can register a service —
// the dev server they started a minute ago is already in this list.
//
// ⚠ THIS COLLECTOR IS CACHED, AND THE CACHE IS THE POINT. Reading it costs a
// spawned process on darwin, and on linux naming the process behind a port means
// walking /proc/<pid>/fd. Paying either every heartbeat is precisely the cost
// pattern the usage track was rewritten to remove (docs/USAGE-COLLECTION.md §1:
// the collection must not cost more than the agent it measures). Ports do not
// move on a five-second scale, so one answer is reused for ListenerTTLSec.
//
// ⚠ NOTHING HERE GOES NEAR THE `exec` FRAME. That path exists so a person can
// run a command through MCP — it needs write scope, caps output at 64 KB and
// admits four at a time. A collector that runs on a timer is not its caller.

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// MaxListeners is heartbeat.listeners' maxItems in the contract.
//
// ⚠ EXCEEDING IT REJECTS THE WHOLE HEARTBEAT rather than the extra rows — the
// resource bars and the session list would go down with the frame. Truncating
// here is what keeps a host with an unusual number of open ports visible at all,
// and Dropped is what stops the truncation from reading as the whole truth.
const MaxListeners = 128

// listenerProcessMax is listener.process's maxLength in the contract.
const listenerProcessMax = 64

// ListenerTTLSec is how long one reading is reused. See the header.
const ListenerTTLSec = 60

// defaultListenerTimeoutMs bounds the darwin lookup. A wedged `lsof` costs this
// pass its port list and nothing else.
const defaultListenerTimeoutMs = 4_000

// procFDBudget caps the linux name pass. Resolving a port's process means
// readlink() on every file descriptor of every process until the socket inode
// turns up, and on a busy host that is tens of thousands of syscalls. The budget
// makes the worst case bounded rather than proportional to how loaded the host
// is; ports whose name is not reached keep their row and lose only the name.
const procFDBudget = 20_000

// ListenerReading is the port list plus the two facts that decide how it renders.
type ListenerReading struct {
	Listeners []protocol.Listener
	// Supported is whether this host could be asked at all. False means the tool
	// needed to look is absent — which is NOT the claim "nothing is listening",
	// and an empty list must never be shown as if it were.
	Supported bool
	// Dropped counts ports the contract's cap left out.
	Dropped int
}

// resolveLsof names the binary to run on darwin.
//
// ⚠ A VARIABLE FOR THE SAME REASON resolveMux IS ONE. Two of the directories
// ResolveBinary searches are absolute system prefixes, so a spec that clears
// PATH still finds the machine's own lsof and passes by measuring the host
// instead of the case it meant to state. That false pass has already happened
// once in this package.
var resolveLsof = func() string { return sys.ResolveBinary("lsof", "") }

// procNetRoot is where the linux reader looks. A variable so a spec can point it
// at a fixture directory and exercise the real reader rather than a parser.
var procNetRoot = "/proc"

// ReadListeners takes one reading, using whatever this OS offers.
func ReadListeners(ctx context.Context, timeoutMs int) ListenerReading {
	switch runtime.GOOS {
	case "linux":
		return readListenersProc()
	case "darwin":
		return readListenersLsof(ctx, timeoutMs)
	}
	// An OS with neither path is not a failure to report every beat; it is a host
	// that cannot answer this question. Supported says so.
	return ListenerReading{Listeners: []protocol.Listener{}, Supported: false}
}

// NewCachedListeners wraps a reader in the TTL the header explains.
//
// The previous answer is served while the TTL holds, including a `Supported:
// false` one — a host without the tool does not grow it between two beats, and
// re-deciding that every five seconds is the cost this cache exists to avoid.
func NewCachedListeners(read func(context.Context) ListenerReading, ttlSec int, now func() int64) func(context.Context) ListenerReading {
	if ttlSec <= 0 {
		ttlSec = ListenerTTLSec
	}
	if now == nil {
		now = nowSeconds
	}
	var mu sync.Mutex
	var cached ListenerReading
	var readAt int64

	return func(ctx context.Context) ListenerReading {
		mu.Lock()
		defer mu.Unlock()
		if readAt != 0 && now()-readAt < int64(ttlSec) {
			return cached
		}
		cached = read(ctx)
		readAt = now()
		return cached
	}
}

// ---------------------------------------------------------------------------
// darwin — lsof
// ---------------------------------------------------------------------------

func readListenersLsof(ctx context.Context, timeoutMs int) ListenerReading {
	// -n and -P keep it from resolving names (a DNS lookup per socket); -sTCP:LISTEN
	// is the filter; -F cn asks for field output and `+c 0` turns off the command
	// truncation. See parseLsofFields for why the last two are not optional.
	result := sys.Run(ctx, resolveLsof(),
		[]string{"-nP", "-iTCP", "-sTCP:LISTEN", "-F", "cn", "+c", "0"},
		sys.Options{TimeoutMs: boundMs(timeoutMs, defaultListenerTimeoutMs)})
	if result.NotFound {
		return ListenerReading{Listeners: []protocol.Listener{}, Supported: false}
	}
	// ⚠ EXIT 1 IS THE ORDINARY ANSWER FOR "NOTHING MATCHED". lsof reports it when
	// its filters select no file, so treating a non-zero exit as a failure would
	// call a quiet host unsupported. Only stdout decides.
	listeners, dropped := parseLsofFields(result.Stdout).result()
	return ListenerReading{Listeners: listeners, Supported: true, Dropped: dropped}
}

// parseLsofFields reads lsof's `-F` field output: one letter per line, and the
// process lines (`p`, `c`) apply to the file lines (`n`) that follow.
//
// ⚠ FIELD OUTPUT RATHER THAN THE TABLE, for two reasons measured on a real host.
// The table truncates COMMAND to nine characters, so `ControlCenter` arrives as
// `ControlCe` and the row names a process that does not exist; and a command
// containing a space — `Google Chrome` — shifts every later column, so splitting
// on whitespace reads the address out of the wrong field. `+c 0` removes the
// truncation and `-F` removes the columns.
func parseLsofFields(text string) *listenerAccumulator {
	acc := newListenerAccumulator()
	process := ""
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimRight(raw, "\r")
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			// A new process section. The command arrives on its own line, so the
			// previous process's name must not survive into this one — a `p` with
			// no `c` after it is a nameless row, not a mislabelled one.
			process = ""
		case 'c':
			process = line[1:]
		case 'n':
			if port, loopback, ok := parseListenAddress(line[1:]); ok {
				acc.add(port, process, loopback)
			}
		}
	}
	return acc
}

// parseListenAddress reads the address forms lsof prints: `*:5432`,
// `127.0.0.1:5432` and `[::1]:5432`.
func parseListenAddress(value string) (port int, loopback bool, ok bool) {
	address := strings.TrimSpace(value)
	// `-sTCP:LISTEN` already filtered, but lsof still appends `(LISTEN)` in some
	// versions. Anything after a space is not part of the address.
	if index := strings.IndexByte(address, ' '); index >= 0 {
		address = address[:index]
	}
	index := strings.LastIndexByte(address, ':')
	if index < 0 {
		return 0, false, false
	}
	port, err := strconv.Atoi(address[index+1:])
	if err != nil || port < 1 || port > 65535 {
		return 0, false, false
	}
	return port, isLoopbackHost(strings.Trim(address[:index], "[]")), true
}

// isLoopbackHost decides the flag the whole forwarding question later turns on.
//
// `*` is every interface, which is the opposite of loopback — reporting it as
// loopback would understate what is already reachable from off the host.
func isLoopbackHost(host string) bool {
	if host == "" || host == "*" {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ---------------------------------------------------------------------------
// linux — /proc
// ---------------------------------------------------------------------------

// procTCPListen is TCP_LISTEN in the state column of /proc/net/tcp.
const procTCPListen = "0A"

func readListenersProc() ListenerReading {
	acc := newListenerAccumulator()
	inodes := map[uint64]int{}
	found := false
	// Both families, because a dev server bound to ::1 is invisible in the first
	// file and a host that only reads one under-reports without saying so.
	for _, name := range []string{"net/tcp", "net/tcp6"} {
		raw, err := os.ReadFile(filepath.Join(procNetRoot, name))
		if err != nil {
			continue
		}
		found = true
		parseProcNetTCP(string(raw), acc, inodes)
	}
	if !found {
		// No /proc at all. Reporting an empty list here would claim a quiet host.
		return ListenerReading{Listeners: []protocol.Listener{}, Supported: false}
	}
	resolveProcNames(inodes, acc)
	listeners, dropped := acc.result()
	return ListenerReading{Listeners: listeners, Supported: true, Dropped: dropped}
}

// parseProcNetTCP reads the listening rows and records each socket's inode, which
// is the only handle /proc/net/tcp gives towards a process name.
func parseProcNetTCP(text string, acc *listenerAccumulator, inodes map[uint64]int) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		// sl, local, remote, st, tx:rx, tr:when, retrnsmt, uid, timeout, inode
		if len(fields) < 10 || fields[3] != procTCPListen {
			continue
		}
		port, loopback, ok := parseProcAddress(fields[1])
		if !ok {
			continue
		}
		acc.add(port, "", loopback)
		if inode, err := strconv.ParseUint(fields[9], 10, 64); err == nil && inode != 0 {
			inodes[inode] = port
		}
	}
}

// parseProcAddress reads `0100007F:1F90` — the address in hex, the port in hex.
func parseProcAddress(value string) (port int, loopback bool, ok bool) {
	index := strings.LastIndexByte(value, ':')
	if index < 0 {
		return 0, false, false
	}
	parsed, err := strconv.ParseUint(value[index+1:], 16, 32)
	if err != nil || parsed < 1 || parsed > 65535 {
		return 0, false, false
	}
	ip, ok := parseProcIP(value[:index])
	if !ok {
		return 0, false, false
	}
	return int(parsed), ip.IsLoopback(), true
}

// parseProcIP decodes the hex address.
//
// ⚠ IT IS NOT PLAIN BIG-ENDIAN HEX, and reading it as such gets loopback exactly
// backwards. The kernel prints each 32-bit word in HOST byte order, so on a
// little-endian machine `0100007F` is 127.0.0.1 and not 1.0.0.127. IPv6 is the
// same rule applied to four words, which is why ::1 appears as twenty-four zeros
// followed by `01000000`.
func parseProcIP(value string) (net.IP, bool) {
	if len(value) == 0 || len(value)%8 != 0 {
		return nil, false
	}
	raw := make([]byte, 0, len(value)/2)
	for start := 0; start < len(value); start += 8 {
		word, err := strconv.ParseUint(value[start:start+8], 16, 32)
		if err != nil {
			return nil, false
		}
		raw = append(raw, byte(word), byte(word>>8), byte(word>>16), byte(word>>24))
	}
	if len(raw) != net.IPv4len && len(raw) != net.IPv6len {
		return nil, false
	}
	return net.IP(raw), true
}

// resolveProcNames walks /proc/<pid>/fd looking for the socket inodes the port
// list needs a name for.
//
// ⚠ THE NAME COMES FROM /proc/<pid>/comm, NEVER FROM cmdline. A command line
// carries arguments, and this repository's own installer takes a single-use
// enrollment code as one — putting argv on the wire would send exactly the thing
// the credential rule keeps out of logs and unit files.
//
// Unreadable processes are skipped rather than reported: an agent running as a
// user cannot see root's descriptors, and a port with no name is still a useful
// row.
func resolveProcNames(inodes map[uint64]int, acc *listenerAccumulator) {
	if len(inodes) == 0 {
		return
	}
	entries, err := os.ReadDir(procNetRoot)
	if err != nil {
		return
	}
	remaining := len(inodes)
	budget := procFDBudget
	for _, entry := range entries {
		if remaining == 0 || budget <= 0 {
			return
		}
		pid := entry.Name()
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}
		fdDir := filepath.Join(procNetRoot, pid, "fd")
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		name := ""
		for _, fd := range fds {
			if budget <= 0 {
				return
			}
			budget--
			link, err := os.Readlink(filepath.Join(fdDir, fd.Name()))
			if err != nil {
				continue
			}
			inode, ok := socketInode(link)
			if !ok {
				continue
			}
			port, wanted := inodes[inode]
			if !wanted {
				continue
			}
			if name == "" {
				name = procComm(pid)
			}
			acc.name(port, name)
			delete(inodes, inode)
			remaining--
		}
	}
}

// socketInode reads the `socket:[12345]` form a socket descriptor links to.
func socketInode(link string) (uint64, bool) {
	const prefix = "socket:["
	if !strings.HasPrefix(link, prefix) || !strings.HasSuffix(link, "]") {
		return 0, false
	}
	inode, err := strconv.ParseUint(link[len(prefix):len(link)-1], 10, 64)
	if err != nil {
		return 0, false
	}
	return inode, true
}

func procComm(pid string) string {
	raw, err := os.ReadFile(filepath.Join(procNetRoot, pid, "comm"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

// ---------------------------------------------------------------------------
// Merging what the two readers produce
// ---------------------------------------------------------------------------

type listenerEntry struct {
	process  string
	loopback bool
}

// listenerAccumulator merges the bindings of one port into one row. A port bound
// on several addresses is one thing to a person, and listing 5432 three times
// makes the table unreadable on any host with dual-stack services.
type listenerAccumulator struct {
	byPort map[int]*listenerEntry
}

func newListenerAccumulator() *listenerAccumulator {
	return &listenerAccumulator{byPort: map[int]*listenerEntry{}}
}

func (a *listenerAccumulator) add(port int, process string, loopback bool) {
	if port < 1 || port > 65535 {
		return
	}
	entry, seen := a.byPort[port]
	if !seen {
		a.byPort[port] = &listenerEntry{process: process, loopback: loopback}
		return
	}
	// ⚠ ONE NON-LOOPBACK BINDING SETTLES IT. A port listening on both 127.0.0.1
	// and 0.0.0.0 is reachable from off the host, and the safe direction for this
	// flag is the one that does not understate exposure.
	entry.loopback = entry.loopback && loopback
	if entry.process == "" {
		entry.process = process
	}
}

func (a *listenerAccumulator) name(port int, process string) {
	if entry, seen := a.byPort[port]; seen && entry.process == "" {
		entry.process = process
	}
}

// result sorts by port and applies the contract's cap.
//
// Sorted because an unordered table reshuffles between beats and reads as
// activity; by port because that is what somebody scanning the list is looking
// for.
func (a *listenerAccumulator) result() ([]protocol.Listener, int) {
	ports := make([]int, 0, len(a.byPort))
	for port := range a.byPort {
		ports = append(ports, port)
	}
	slices.Sort(ports)

	dropped := 0
	if len(ports) > MaxListeners {
		dropped = len(ports) - MaxListeners
		ports = ports[:MaxListeners]
	}

	out := make([]protocol.Listener, 0, len(ports))
	for _, port := range ports {
		entry := a.byPort[port]
		item := protocol.NewListener()
		item.Port = port
		item.Process = truncateRunes(entry.process, listenerProcessMax)
		item.LoopbackOnly = entry.loopback
		out = append(out, item)
	}
	return out, dropped
}
