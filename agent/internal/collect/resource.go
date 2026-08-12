package collect

// CPU / memory / swap / disk for one host.
//
// Ported from apps/agent/src/collect/resource.ts, including the two rules that
// file was written around:
//
//   - CPU needs TWO /proc/stat samples. A single read is the average since boot,
//     which on a week-old box is a flat number that never moves.
//   - A failed measurement is nil, never 0. A zero draws an idle machine, and an
//     idle machine is exactly what an operator must not be told when the truth is
//     "we could not look".
//
// WHY EVERY READER IS A FUNC ON A STRUCT: the numbers come from the host, so a
// spec that asserted against them would assert against whatever machine it runs
// on. Injecting the reads is what makes "a meminfo with these exact numbers"
// expressible.
//
// ⚠ WHERE GO IS THINNER THAN NODE: Node's os.loadavg/os.totalmem/os.freemem/
// os.uptime are portable, and the TypeScript used them as per-metric fallbacks
// for hosts without /proc. Go's standard library has no equivalent (they need
// cgo or golang.org/x/sys, and this module deliberately has neither). On macOS
// they are answered instead by the tools the system ships — see
// `resource_macos.go`, which adds no dependency and follows the precedent `df -Pk`
// already set. Anywhere else that is still nil: "not measured", which is true,
// rather than a number obtained another way. Disk is unaffected: `df -Pk` is POSIX.

import (
	"context"
	"math"
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// The files every reader defaults to. Named so a spec can point the same reader
// at a fixture instead.
const (
	procStatPath    = "/proc/stat"
	procMeminfoPath = "/proc/meminfo"
	procLoadavgPath = "/proc/loadavg"
	procUptimePath  = "/proc/uptime"
)

// defaultDiskTimeoutMs bounds `df`. A stalled NFS mount is the reason this is a
// timeout and not a plain call: the pass must lose the disk reading, not itself.
const defaultDiskTimeoutMs = 4_000

// cpuSample is one /proc/stat reading, in jiffies.
type cpuSample struct {
	total int64
	idle  int64
}

// parseProcStat reads the aggregate line: `cpu  user nice system idle iowait irq
// softirq …`. Idle counts iowait too — a process blocked on disk is not the CPU
// being busy.
//
// nil means the text was not a /proc/stat, which the caller turns into a
// fallback, not into a zero.
func parseProcStat(text string) *cpuSample {
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		if len(fields) < 5 {
			return nil
		}
		sample := cpuSample{}
		for index, field := range fields {
			value, err := strconv.ParseInt(field, 10, 64)
			if err != nil {
				return nil
			}
			sample.total += value
			// Fields 3 and 4 (idle, iowait) after the leading label.
			if index == 3 || index == 4 {
				sample.idle += value
			}
		}
		return &sample
	}
	return nil
}

// cpuPctFromSamples is busy time over elapsed time between two samples.
func cpuPctFromSamples(previous, current cpuSample) *int {
	deltaTotal := current.total - previous.total
	deltaIdle := current.idle - previous.idle
	// A counter that went backwards means the host rebooted between passes.
	if deltaTotal <= 0 || deltaIdle < 0 {
		return nil
	}
	return ptr(clampPct(float64(deltaTotal-deltaIdle) * 100 / float64(deltaTotal)))
}

// clampPct produces the contract's `percent`.
//
// ⚠ THE ROUNDING IS NOT COSMETIC. `percent` is an INTEGER 0..100, and the whole
// frame is validated before it is sent: a CPU reading of 42.5 does not arrive as
// 42.5, it fails the element, fails the resource, fails the heartbeat — and the
// host silently stops reporting anything at all. So every percentage in this
// package is produced here and nowhere else, and it is rounded at the moment it
// becomes a percentage rather than anywhere later.
//
// The clamp is the same argument from the other side: a `df` that reports 101%
// (it happens, with reserved blocks) must cost its own digit, not the frame.
//
// NaN cannot reach here — every caller checks its inputs first — but mapping it
// to 0 keeps the function total, because int(NaN) is undefined in Go.
func clampPct(value float64) int {
	if math.IsNaN(value) {
		return 0
	}
	rounded := math.Round(value)
	if rounded <= 0 {
		return 0
	}
	if rounded >= 100 {
		return 100
	}
	return int(rounded)
}

// StatReader returns the text of a /proc file; ok is false when the host has no
// such file (which is every non-Linux host, and is not an error).
type StatReader func() (text string, ok bool)

// LoadReader returns the 1-minute load average. Only load1 is ever consumed — by
// the CPU fallback and by the heartbeat's own `load1` — so the reader returns
// that one number rather than the triple Node's os.loadavg() hands back.
type LoadReader func() (load1 float64, ok bool)

// CPUMeterOptions are the injectable parts of a CPUMeter. A zero value gives the
// real host readers.
type CPUMeterOptions struct {
	ReadStat  StatReader
	Load      LoadReader
	CoreCount int
}

// CPUMeter measures CPU across passes.
//
// WHY NOT SLEEP 300ms LIKE THE SHELL VERSION IT REPLACES: the collector already
// runs on a timer, so the previous pass is a free — and wider, therefore less
// noisy — window. The first pass has no predecessor and reports nil rather than a
// made-up number; a fresh agent legitimately shows "—" for one beat.
type CPUMeter struct {
	previous  *cpuSample
	readStat  StatReader
	load      LoadReader
	coreCount int
}

// NewCPUMeter builds a meter, filling in the host readers for anything omitted.
func NewCPUMeter(options CPUMeterOptions) *CPUMeter {
	meter := &CPUMeter{
		readStat:  options.ReadStat,
		load:      options.Load,
		coreCount: options.CoreCount,
	}
	if meter.readStat == nil {
		meter.readStat = func() (string, bool) { return readTextFile(procStatPath) }
	}
	if meter.load == nil {
		meter.load = ReadLoad1
	}
	if meter.coreCount <= 0 {
		meter.coreCount = runtime.NumCPU()
	}
	return meter
}

// Sample returns the percentage since the previous call, or nil when there is
// nothing honest to report yet.
//
// NOT SAFE FOR CONCURRENT USE, and it does not need to be: exactly one heartbeat
// pass runs at a time and it owns the meter. A mutex here would advertise a
// sharing pattern that would also be wrong for a different reason (two callers
// would each see half the elapsed jiffies).
func (m *CPUMeter) Sample() *int {
	text, ok := m.readStat()
	if !ok {
		return m.loadFallback()
	}
	current := parseProcStat(text)
	if current == nil {
		return m.loadFallback()
	}
	previous := m.previous
	m.previous = current
	if previous == nil {
		return nil
	}
	return cpuPctFromSamples(*previous, *current)
}

// loadFallback is the honest stand-in for a host with no /proc/stat: load per
// core, which is the same quantity at a coarser resolution.
func (m *CPUMeter) loadFallback() *int {
	one, ok := m.load()
	if !ok || math.IsNaN(one) || math.IsInf(one, 0) {
		return nil
	}
	cores := m.coreCount
	if cores < 1 {
		cores = 1
	}
	return ptr(clampPct(one / float64(cores) * 100))
}

// MemoryReading is memory as `free` defines it.
type MemoryReading struct {
	UsedBytes  int64
	TotalBytes int64
	Pct        int
}

// parseMeminfo uses `MemAvailable`, which is the used/total definition `free`
// prints — buffers and cache are available, so counting them as used reports 90%
// on every healthy Linux box and trains people to ignore the number.
func parseMeminfo(text string) *MemoryReading {
	var total, available int64
	haveTotal, haveAvailable := false, false
	for _, line := range strings.Split(text, "\n") {
		key, rest, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		fields := strings.Fields(rest)
		// `MemTotal:  8000000 kB` — anything without the unit is not a size.
		if len(fields) != 2 || fields[1] != "kB" {
			continue
		}
		kb, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			continue
		}
		switch key {
		case "MemTotal":
			total, haveTotal = kb*1024, true
		case "MemAvailable":
			available, haveAvailable = kb*1024, true
		}
	}
	if !haveTotal || !haveAvailable || total <= 0 {
		return nil
	}
	used := max(0, total-available)
	return &MemoryReading{
		UsedBytes:  used,
		TotalBytes: total,
		Pct:        clampPct(float64(used) * 100 / float64(total)),
	}
}

// ReadMemory reads memory from /proc/meminfo. nil is "not measured" — see the
// file header for why there is no second source on a non-Linux host.
func ReadMemory(read StatReader) *MemoryReading {
	// ⚠ THE macOS SOURCE BELONGS TO THE DEFAULT READER, NOT TO THE ERROR PATH. An
	// INJECTED reader that fails is a caller saying "there is nothing to read", and
	// answering it with this machine's real memory is the exact thing the injection
	// exists to prevent — a spec would then assert against whatever host it ran on.
	// So only the absence of a reader reaches the host's own second source.
	if read != nil {
		text, ok := read()
		if !ok {
			return nil
		}
		return parseMeminfo(text)
	}
	text, ok := readTextFile(procMeminfoPath)
	if !ok {
		if runtime.GOOS == "darwin" {
			return readDarwinMemory()
		}
		return nil
	}
	return parseMeminfo(text)
}

// SwapReading is the swap area as `free` describes it.
//
// ⚠ A HOST WITH NO SWAP IS A MEASUREMENT, NOT A FAILURE, and that is why Pct is
// a plain int like its two neighbours rather than a pointer. Every container and
// every server built with swap off reports `SwapTotal: 0 kB`, and the honest
// reading of that is "nothing is swapped": 0 used, 0 total, 0 per cent. The
// tooltip's "0B/0B" is what separates it from a host whose swap merely happens
// to be empty ("0B/8Gi") — a percentage alone cannot, which is the same argument
// the absolute bytes were added for in the first place.
//
// nil, as everywhere else in this file, stays reserved for "we could not look".
type SwapReading struct {
	UsedBytes  int64
	TotalBytes int64
	Pct        int
}

// newSwapReading is the one place 0/0 is decided, so a swapless host answers
// identically whether the numbers came from /proc/meminfo or from `sysctl
// vm.swapusage` — and both really do reach it. Measured on macOS 26.5.2 (build
// 25F84, 2026-08-07): a Mac that has not swapped yet reports `total = 0.00M`
// with dynamic swap fully enabled, so this is not a Linux-only branch.
func newSwapReading(total, used int64) *SwapReading {
	if total < 0 || used < 0 {
		return nil
	}
	if used > total {
		// A `free` that raced a `swapoff`, or three sysctl figures formatted a
		// moment apart. Cap rather than refuse: one figure should cost its own
		// digit, not the whole reading — the same call `df`'s 101% already gets.
		used = total
	}
	reading := &SwapReading{UsedBytes: used, TotalBytes: total}
	// ⚠ NOT clampPct(NaN), WHICH ALSO HAPPENS TO BE 0. That branch is a totality
	// guard for a function whose callers check their inputs first; reaching it
	// with a real 0/0 would be using it as an answer, and the next person to
	// tighten it would silently change what a swapless host reports.
	if total > 0 {
		reading.Pct = clampPct(float64(used) * 100 / float64(total))
	}
	return reading
}

// parseMeminfoSwap reads SwapTotal/SwapFree out of the same /proc/meminfo text
// `parseMeminfo` reads, in the same `kB` form.
//
// USED IS TOTAL MINUS FREE, WITH NO `available` EQUIVALENT, and that asymmetry
// with the memory figure above is deliberate. MemAvailable exists because page
// cache counted as used reports 90% on a healthy box; swap has no cache to
// discount. A page in swap is a page that did not fit.
//
// ⚠ THE SWITCH MATCHES THE KEY EXACTLY, WHICH IS WHAT KEEPS `SwapCached` OUT.
// /proc/meminfo has three keys beginning "Swap" and only two of them size the
// swap area; a prefix match would fold SwapCached into an accumulator and be
// wrong by an amount no percentage looks odd enough to catch.
//
// nil is "this file did not say", which is NOT what `SwapTotal: 0` says. Modern
// kernels print the swap lines even with CONFIG_SWAP=n, so an absent SwapTotal
// means a masked or truncated /proc (lxcfs, gVisor, a sandbox) — and a /proc we
// could not read must not be reported as a host with swap turned off.
func parseMeminfoSwap(text string) *SwapReading {
	var total, free int64
	haveTotal, haveFree := false, false
	for _, line := range strings.Split(text, "\n") {
		key, rest, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		fields := strings.Fields(rest)
		// `SwapTotal:  2000000 kB` — anything without the unit is not a size, which
		// is how the unitless lines in the same file (HugePages_Total: 0) stay out.
		if len(fields) != 2 || fields[1] != "kB" {
			continue
		}
		kb, err := strconv.ParseInt(fields[0], 10, 64)
		// `parseMeminfo` gets this from its `total <= 0` guard; here 0 is a legal
		// total, so a negative one has to be refused explicitly.
		if err != nil || kb < 0 {
			continue
		}
		switch key {
		case "SwapTotal":
			total, haveTotal = kb*1024, true
		case "SwapFree":
			free, haveFree = kb*1024, true
		}
	}
	// Half a reading is not a reading: without both, used is not computable and a
	// zero would claim the host has no swap.
	if !haveTotal || !haveFree {
		return nil
	}
	return newSwapReading(total, max(0, total-free))
}

// ReadSwap reads swap from /proc/meminfo, or from `sysctl vm.swapusage` on macOS.
//
// ⚠ THE SAME FILE IS READ TWICE PER PASS, ONCE HERE AND ONCE IN ReadMemory, AND
// THAT IS THE CHEAPER OF THE TWO MISTAKES. One shared read means one reading
// carrying both, and then a kernel too old for MemAvailable — the case
// `parseMeminfo` already returns nil for, with its own spec — would drag a
// perfectly readable SwapTotal down with it. "A failed measurement is nil" is a
// PER-FIELD rule here, and a second open() of a 1.4 kB pseudo-file is what it
// costs to keep it one. The pass this sits in already spawns `df`.
//
// ⚠ AND THE macOS SOURCE BELONGS TO THE DEFAULT READER, NOT TO THE ERROR PATH —
// same rule and same reason as ReadMemory next door.
func ReadSwap(read StatReader) *SwapReading {
	if read != nil {
		text, ok := read()
		if !ok {
			return nil
		}
		return parseMeminfoSwap(text)
	}
	text, ok := readTextFile(procMeminfoPath)
	if !ok {
		if runtime.GOOS == "darwin" {
			return readDarwinSwap()
		}
		return nil
	}
	return parseMeminfoSwap(text)
}

// DiskReading is the filesystem behind one path.
type DiskReading struct {
	UsedBytes  int64
	TotalBytes int64
	Pct        int
}

// parseDf reads POSIX `df -Pk <path>` output, whose second line is the
// filesystem: `device blocks used available capacity mount`.
func parseDf(text string) *DiskReading {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) < 2 {
		return nil
	}
	fields := strings.Fields(lines[1])
	if len(fields) < 3 {
		return nil
	}
	blocks, blocksErr := strconv.ParseInt(fields[1], 10, 64)
	used, usedErr := strconv.ParseInt(fields[2], 10, 64)
	if blocksErr != nil || usedErr != nil || blocks <= 0 || used < 0 {
		return nil
	}
	totalBytes := blocks * 1024
	usedBytes := used * 1024
	return &DiskReading{
		UsedBytes:  usedBytes,
		TotalBytes: totalBytes,
		Pct:        clampPct(float64(usedBytes) * 100 / float64(totalBytes)),
	}
}

// ReadDisk shells out to `df`, which is the portable answer and the only one
// that knows what is actually mounted at the path.
func ReadDisk(ctx context.Context, path string, timeoutMs int) *DiskReading {
	if path == "" {
		path = "/"
	}
	result := sys.Run(ctx, "df", []string{"-Pk", path}, sys.Options{TimeoutMs: boundMs(timeoutMs, defaultDiskTimeoutMs)})
	if result.Code != 0 {
		return nil
	}
	return parseDf(result.Stdout)
}

// ReadLoad1 is the 1-minute load average from /proc/loadavg, or from `sysctl` on
// macOS.
//
// ⚠ THIS ONE ALSO TURNS CPU ON. `CPUMeter.loadFallback` reports load per core for
// any host with no /proc/stat, and that path was unreachable on macOS purely
// because this function had no second source there.
func ReadLoad1() (float64, bool) {
	text, ok := readTextFile(procLoadavgPath)
	if !ok {
		if runtime.GOOS == "darwin" {
			return readDarwinLoad1()
		}
		return 0, false
	}
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return 0, false
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0, false
	}
	return value, true
}

// ReadUptimeSec is the HOST's uptime from /proc/uptime — not the agent's. An
// agent restarted five minutes ago on a box that has been up for a month must
// not report five minutes.
func ReadUptimeSec() (int64, bool) {
	text, ok := readTextFile(procUptimePath)
	if !ok {
		if runtime.GOOS == "darwin" {
			return readDarwinUptimeSec()
		}
		return 0, false
	}
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return 0, false
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return 0, false
	}
	return int64(math.Max(0, math.Round(seconds))), true
}

// ResourceReaders are the sources one Resource is assembled from. Every field is
// optional; a nil one is filled in with the host reader.
type ResourceReaders struct {
	// CPU is stateful (it remembers the previous /proc/stat), so it is owned by
	// the caller and lives across passes.
	CPU    *CPUMeter
	Memory func() *MemoryReading
	// Swap is its own seam rather than a field of the memory reading, so that a
	// meminfo whose MemAvailable is missing loses memory and keeps swap. See
	// ReadSwap for the second read this costs and why it is worth paying.
	Swap      func() *SwapReading
	Disk      func(ctx context.Context) *DiskReading
	Load      LoadReader
	UptimeSec func() (int64, bool)
}

// Resource assembles one resource reading. Absolute bytes travel with the
// percentages because a tooltip wants "12Gi/30Gi" and a percentage alone cannot
// produce it.
func Resource(ctx context.Context, readers ResourceReaders) protocol.Resource {
	out := protocol.NewResource()

	// No meter means no CPU reading. Building a throwaway one per pass would
	// report nil forever anyway (it never has a predecessor), only less obviously.
	if readers.CPU != nil {
		out.CPUPct = readers.CPU.Sample()
	}

	readMemory := readers.Memory
	if readMemory == nil {
		readMemory = func() *MemoryReading { return ReadMemory(nil) }
	}
	if memory := readMemory(); memory != nil {
		out.MemPct = ptr(memory.Pct)
		out.MemUsedBytes = ptr(float64(memory.UsedBytes))
		out.MemTotalBytes = ptr(float64(memory.TotalBytes))
	}

	readSwap := readers.Swap
	if readSwap == nil {
		readSwap = func() *SwapReading { return ReadSwap(nil) }
	}
	if swap := readSwap(); swap != nil {
		// ⚠ ALL THREE TRAVEL TOGETHER, AND THE PAIRING IS THE SIGNAL. Total 0 with
		// pct 0 is "this host has no swap" — measured. All three absent is "we could
		// not look", which is also what an agent too old to know the word swap
		// produces. Emitting the first as the second would make upgrading such an
		// agent look like it changed nothing.
		out.SwapPct = ptr(swap.Pct)
		out.SwapUsedBytes = ptr(float64(swap.UsedBytes))
		out.SwapTotalBytes = ptr(float64(swap.TotalBytes))
	}

	readDisk := readers.Disk
	if readDisk == nil {
		readDisk = func(ctx context.Context) *DiskReading { return ReadDisk(ctx, "/", defaultDiskTimeoutMs) }
	}
	if disk := readDisk(ctx); disk != nil {
		out.DiskPct = ptr(disk.Pct)
		out.DiskUsedBytes = ptr(float64(disk.UsedBytes))
		out.DiskTotalBytes = ptr(float64(disk.TotalBytes))
	}

	readLoad := readers.Load
	if readLoad == nil {
		readLoad = ReadLoad1
	}
	// The contract floors load1 at 0. A negative reading is not a load average,
	// and sending one would cost the whole frame rather than this one field.
	if load1, ok := readLoad(); ok && !math.IsNaN(load1) && !math.IsInf(load1, 0) && load1 >= 0 {
		out.Load1 = ptr(load1)
	}

	readUptime := readers.UptimeSec
	if readUptime == nil {
		readUptime = ReadUptimeSec
	}
	if uptime, ok := readUptime(); ok && uptime >= 0 {
		out.UptimeSec = ptr(uptime)
	}

	return out
}

func readTextFile(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}

// ptr is how a measurement becomes a nullable contract field. It exists so that
// writing a value and writing "not measured" look different at every call site:
// `ptr(x)` versus leaving the field alone.
func ptr[T any](value T) *T { return &value }

// boundMs keeps a timeout positive. A zero would otherwise mean "no timeout" to
// net.Dialer and "already expired" to sys.Run — the two worst possible readings
// of the same missing number, and a struct-literal AgentConfig has zeros.
func boundMs(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}
