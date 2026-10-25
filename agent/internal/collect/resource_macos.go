package collect

// macOS metrics use bounded tools shipped with the OS, without cgo or an
// additional runtime dependency. Pure parsers also run against fixtures on CI.

import (
	"context"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// macOS ships these tools in /usr/sbin and /usr/bin, and they are bounded
// like `df` is: a host that cannot answer in this long is a host we report nil
// for, not one the heartbeat waits behind.
const darwinSysctlTimeoutMs = 2_000

// parseDarwinCPU reads CPU-only `iostat -d -C -n 0 -c 2 -w 1` output.
// The first row is the average since boot; only the second, one-second interval
// describes current utilization. Load average must never substitute for it.
func parseDarwinCPU(text string) *int {
	header := false
	var readings []int
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 {
			continue
		}
		if fields[0] == "us" && fields[1] == "sy" && fields[2] == "id" {
			header = true
			continue
		}
		if !header {
			continue
		}
		var values [3]float64
		for index, field := range fields {
			value, err := strconv.ParseFloat(field, 64)
			if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 100 {
				return nil
			}
			values[index] = value
		}
		if total := values[0] + values[1] + values[2]; total < 99 || total > 101 {
			return nil
		}
		readings = append(readings, clampPct(100-values[2]))
	}
	if len(readings) != 2 {
		return nil
	}
	return ptr(readings[1])
}

func readDarwinCPU(ctx context.Context) *int {
	text, ok := runDarwinToolContext(ctx, "/usr/sbin/iostat", []string{"-d", "-C", "-n", "0", "-c", "2", "-w", "1"})
	if !ok {
		return nil
	}
	return parseDarwinCPU(text)
}

// parseSysctlLoadavg reads `sysctl -n vm.loadavg`, which prints the triple inside
// braces: `{ 7.76 5.43 4.50 }`. Only load1 is consumed, matching `ReadLoad1`.
func parseSysctlLoadavg(text string) (float64, bool) {
	trimmed := strings.TrimSpace(text)
	trimmed = strings.TrimPrefix(trimmed, "{")
	trimmed = strings.TrimSuffix(trimmed, "}")
	fields := strings.Fields(trimmed)
	if len(fields) == 0 {
		return 0, false
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0, false
	}
	return value, true
}

// parseSysctlBoottime reads `sysctl -n kern.boottime`:
//
//	{ sec = 1784361150, usec = 38040 } Sat Jul 18 16:52:30 2026
//
// It returns the boot instant in unix seconds; the caller turns that into an
// uptime, so that the answer is the HOST's uptime rather than the agent's — the
// same distinction `ReadUptimeSec` is written around.
func parseSysctlBoottime(text string) (int64, bool) {
	_, rest, found := strings.Cut(text, "sec")
	if !found {
		return 0, false
	}
	_, rest, found = strings.Cut(rest, "=")
	if !found {
		return 0, false
	}
	// `1784361150, usec = 38040 } Sat …` — the seconds run up to the comma.
	digits, _, _ := strings.Cut(rest, ",")
	seconds, err := strconv.ParseInt(strings.TrimSpace(digits), 10, 64)
	if err != nil || seconds <= 0 {
		return 0, false
	}
	return seconds, true
}

// parseVMStatPages reads `vm_stat`, whose header carries the page size and whose
// body is `Pages free:  514289.` — one label per line, trailing full stop.
//
// Returns bytes, not pages, so the caller never has to remember which unit it is
// holding. ok is false unless the page size and at least the free count are
// present, because a zero page size would silently make every figure zero.
func parseVMStatPages(text string) (map[string]int64, bool) {
	pageSize := int64(0)
	if _, rest, found := strings.Cut(text, "page size of "); found {
		digits, _, _ := strings.Cut(rest, " ")
		if parsed, err := strconv.ParseInt(strings.TrimSpace(digits), 10, 64); err == nil && parsed > 0 {
			pageSize = parsed
		}
	}
	if pageSize <= 0 {
		return nil, false
	}

	bytesByLabel := map[string]int64{}
	for _, line := range strings.Split(text, "\n") {
		label, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		label = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(label), "Pages "))
		value = strings.TrimSpace(value)
		value = strings.TrimSuffix(value, ".")
		pages, err := strconv.ParseInt(value, 10, 64)
		if err != nil || pages < 0 {
			continue
		}
		bytesByLabel[label] = pages * pageSize
	}
	if _, ok := bytesByLabel["free"]; !ok {
		return nil, false
	}
	return bytesByLabel, true
}

// darwinMemory combines `hw.memsize` (total) with `vm_stat` (what is reclaimable).
//
// ⚠ IT MIRRORS MemAvailable, NOT "free". `parseMeminfo` next door uses Linux's
// MemAvailable on purpose — counting cache as used reports 90% on every healthy
// box and trains people to ignore the number. The macOS equivalent of "could be
// handed to a process that asked" is free + inactive + speculative + purgeable,
// so that is what is subtracted. Wired and active are genuinely spoken for, and
// the compressor's pages are too, which is why neither is credited back.
func darwinMemory(memsizeText string, vmStatText string) *MemoryReading {
	total, err := strconv.ParseInt(strings.TrimSpace(memsizeText), 10, 64)
	if err != nil || total <= 0 {
		return nil
	}
	pages, ok := parseVMStatPages(vmStatText)
	if !ok {
		return nil
	}
	available := pages["free"] + pages["inactive"] + pages["speculative"] + pages["purgeable"]
	if available > total {
		available = total
	}
	used := total - available
	return &MemoryReading{
		UsedBytes:  used,
		TotalBytes: total,
		Pct:        clampPct(float64(used) * 100 / float64(total)),
	}
}

// parseSysctlSwapusage reads `sysctl -n vm.swapusage`:
//
//	total = 3072.00M  used = 1234.50M  free = 1837.50M  (encrypted)
//
// ⚠ macOS KEEPS SWAP CAPACITY OUT OF vm_stat, so this is a THIRD tool beside
// `hw.memsize` and `vm_stat` rather than another field of one of them. `vm_stat`
// has Swapins and Swapouts, which are counters since boot; nothing in its output
// adds up to the SIZE of the swap area. Anyone who tries to fold this into
// parseVMStatPages will find only the counters.
//
// ⚠ AN UNRECOGNISED UNIT SUFFIX IS A REFUSAL, NOT A NUMBER OF BYTES. Reading
// `3072.00G` as 3072 bytes is a factor of 10^9 that arrives on screen as a
// plausible small figure, and nothing downstream would look at it twice. A bare
// number with no suffix refuses for the same reason: the suffix carries the
// magnitude. Measured on macOS 26.5.2 (build 25F84, 2026-08-07), sysctl(8)
// formats all three figures with an unconditional `%.2fM`, so K and G are
// defensive — three lines against a formatter change that would otherwise be
// silent. That `%.2f` also quantises the byte counts to about 10 KiB: they are a
// size, not an exact count.
//
// Both output forms are tolerated — the `vm.swapusage: ` prefix that appears
// without `-n`, and the trailing `(encrypted)` — because the two wanted figures
// are taken by name and everything else is ignored.
func parseSysctlSwapusage(text string) *SwapReading {
	total, okTotal := swapusageField(text, "total")
	used, okUsed := swapusageField(text, "used")
	if !okTotal || !okUsed {
		return nil
	}
	return newSwapReading(total, used)
}

// swapusageField pulls one `<name> = 1234.50M` figure out of the line, in bytes.
//
// `free` is deliberately never read: total and used are the two the contract
// carries, and a reading that derives nothing from the third cannot disagree
// with itself when the three were formatted a moment apart.
func swapusageField(text string, name string) (int64, bool) {
	_, rest, found := strings.Cut(text, name+" = ")
	if !found {
		return 0, false
	}
	field, _, _ := strings.Cut(strings.TrimSpace(rest), " ")
	if field == "" {
		return 0, false
	}
	var scale int64
	switch field[len(field)-1] {
	case 'K':
		scale = 1 << 10
	case 'M':
		scale = 1 << 20
	case 'G':
		scale = 1 << 30
	default:
		return 0, false
	}
	value, err := strconv.ParseFloat(field[:len(field)-1], 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0, false
	}
	// M means MiB here: sysctl divides by 1024*1024, not by a million.
	return int64(math.Round(value * float64(scale))), true
}

// runDarwinTool is the one place a subprocess is spawned for these metrics, so
// the timeout and the "non-zero means nil" rule are stated once.
func runDarwinTool(file string, args []string) (string, bool) {
	return runDarwinToolContext(context.Background(), file, args)
}

func runDarwinToolContext(ctx context.Context, file string, args []string) (string, bool) {
	result := sys.Run(ctx, file, args, sys.Options{TimeoutMs: darwinSysctlTimeoutMs})
	if result.Code != 0 {
		return "", false
	}
	return result.Stdout, true
}

// readDarwinLoad1, readDarwinMemory and readDarwinUptimeSec are the host-facing
// halves. They are only ever reached after the /proc read has already failed.
func readDarwinLoad1() (float64, bool) {
	text, ok := runDarwinTool("sysctl", []string{"-n", "vm.loadavg"})
	if !ok {
		return 0, false
	}
	return parseSysctlLoadavg(text)
}

func readDarwinMemory() *MemoryReading {
	memsize, ok := runDarwinTool("sysctl", []string{"-n", "hw.memsize"})
	if !ok {
		return nil
	}
	vmStat, ok := runDarwinTool("vm_stat", nil)
	if !ok {
		return nil
	}
	return darwinMemory(memsize, vmStat)
}

func readDarwinSwap() *SwapReading {
	text, ok := runDarwinTool("sysctl", []string{"-n", "vm.swapusage"})
	if !ok {
		return nil
	}
	return parseSysctlSwapusage(text)
}

func readDarwinUptimeSec() (int64, bool) {
	text, ok := runDarwinTool("sysctl", []string{"-n", "kern.boottime"})
	if !ok {
		return 0, false
	}
	bootUnix, ok := parseSysctlBoottime(text)
	if !ok {
		return 0, false
	}
	uptime := nowUnix() - bootUnix
	if uptime < 0 {
		// A clock that moved backwards past boot. Nil beats a negative uptime.
		return 0, false
	}
	return uptime, true
}

// nowUnix is a variable so a spec can pin the clock; boottime alone cannot be
// turned into a stable expectation.
var nowUnix = func() int64 { return time.Now().Unix() }
