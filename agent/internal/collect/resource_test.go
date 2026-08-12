package collect

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The two /proc/stat samples the TypeScript spec uses: 800 ticks elapsed between
// them, 600 of those idle, so the answer is 25% and can be checked by hand.
const (
	statA = "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\nintr 1 2 3\n"
	statB = "cpu  200 0 200 1400 0 0 0 0 0 0\ncpu0 100 0 100 700 0 0 0 0 0 0\nintr 1 2 3\n"
)

// procFile writes a /proc-shaped fixture and returns a reader for it. The point
// is that these numbers are the same on every machine the suite runs on — a spec
// that read the real /proc/stat would be asserting against the test runner.
func procFile(t *testing.T, name, contents string) StatReader {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("writing fixture: %v", err)
	}
	return func() (string, bool) { return readTextFile(path) }
}

func TestCPU(t *testing.T) {
	t.Run("[TC-PDAGENT-010] derives cpu from the delta of two /proc/stat samples", func(t *testing.T) {
		a, b := parseProcStat(statA), parseProcStat(statB)
		if a == nil || b == nil {
			t.Fatalf("samples did not parse: %v %v", a, b)
		}
		if a.total != 1_000 || a.idle != 800 {
			t.Fatalf("first sample = %+v, want {1000 800}", *a)
		}
		if b.total != 1_800 || b.idle != 1_400 {
			t.Fatalf("second sample = %+v, want {1800 1400}", *b)
		}
		got := cpuPctFromSamples(*a, *b)
		if got == nil || *got != 25 {
			t.Fatalf("cpu = %v, want 25", derefInt(got))
		}
	})

	t.Run("[TC-PDAGENT-010] reports nil on the first pass instead of a made-up zero", func(t *testing.T) {
		samples := []string{statA, statB}
		index := 0
		meter := NewCPUMeter(CPUMeterOptions{ReadStat: func() (string, bool) {
			if index >= len(samples) {
				return "", false
			}
			text := samples[index]
			index++
			return text, true
		}})
		if first := meter.Sample(); first != nil {
			t.Fatalf("first sample = %d, want nil (no predecessor to compare against)", *first)
		}
		if second := meter.Sample(); second == nil || *second != 25 {
			t.Fatalf("second sample = %v, want 25", derefInt(second))
		}
	})

	t.Run("[TC-PDAGENT-010] reads the real file through the default reader", func(t *testing.T) {
		read := procFile(t, "stat", statA)
		meter := NewCPUMeter(CPUMeterOptions{ReadStat: read})
		if first := meter.Sample(); first != nil {
			t.Fatalf("first sample = %d, want nil", *first)
		}
		// The same file twice: no ticks elapsed, which is not 0% busy — it is
		// nothing to divide by, and therefore no measurement.
		if second := meter.Sample(); second != nil {
			t.Fatalf("second sample = %d, want nil for a zero-width window", *second)
		}
	})

	t.Run("[TC-PDAGENT-010] falls back to load per core when /proc/stat is absent", func(t *testing.T) {
		meter := NewCPUMeter(CPUMeterOptions{
			ReadStat:  func() (string, bool) { return "", false },
			Load:      func() (float64, bool) { return 2, true },
			CoreCount: 4,
		})
		if got := meter.Sample(); got == nil || *got != 50 {
			t.Fatalf("fallback = %v, want 50", derefInt(got))
		}
	})

	t.Run("[TC-PDAGENT-010] reports nil when neither /proc/stat nor load is readable", func(t *testing.T) {
		meter := NewCPUMeter(CPUMeterOptions{
			ReadStat: func() (string, bool) { return "", false },
			Load:     func() (float64, bool) { return 0, false },
		})
		if got := meter.Sample(); got != nil {
			t.Fatalf("cpu = %d, want nil — an unmeasurable host is not an idle one", *got)
		}
	})

	t.Run("[TC-PDAGENT-010] treats a counter that went backwards (reboot) as unknown", func(t *testing.T) {
		got := cpuPctFromSamples(cpuSample{total: 1_800, idle: 1_400}, cpuSample{total: 1_000, idle: 800})
		if got != nil {
			t.Fatalf("cpu = %d, want nil after a reboot", *got)
		}
	})

	t.Run("[TC-PDAGENT-010] rejects a /proc/stat it cannot read as numbers", func(t *testing.T) {
		if got := parseProcStat("cpu  a b c d e\n"); got != nil {
			t.Fatalf("parsed %+v from non-numeric fields", *got)
		}
		if got := parseProcStat("cpu  1 2 3\n"); got != nil {
			t.Fatalf("parsed %+v from a short line", *got)
		}
		if got := parseProcStat("intr 1 2 3\n"); got != nil {
			t.Fatalf("parsed %+v from a file with no cpu line", *got)
		}
	})
}

func TestMemory(t *testing.T) {
	t.Run("[TC-PDAGENT-011] uses MemAvailable, not MemFree, for used memory", func(t *testing.T) {
		reading := parseMeminfo("MemTotal:       8000000 kB\nMemFree:         100000 kB\nMemAvailable:   4000000 kB\n")
		if reading == nil {
			t.Fatal("meminfo did not parse")
		}
		// Counting cache as used would report 98% here, which is the number that
		// trains people to ignore the gauge.
		if reading.UsedBytes != 4_096_000_000 || reading.TotalBytes != 8_192_000_000 || reading.Pct != 50 {
			t.Fatalf("reading = %+v, want used 4096000000 / total 8192000000 / 50%%", *reading)
		}
	})

	t.Run("[TC-PDAGENT-011] returns nil for meminfo it cannot read", func(t *testing.T) {
		if got := parseMeminfo("garbage"); got != nil {
			t.Fatalf("parsed %+v from garbage", *got)
		}
		// MemTotal without MemAvailable is a kernel too old to answer the question.
		if got := parseMeminfo("MemTotal: 8000000 kB\n"); got != nil {
			t.Fatalf("parsed %+v with no MemAvailable", *got)
		}
	})

	t.Run("[TC-PDAGENT-011] reports nil when there is no /proc/meminfo at all", func(t *testing.T) {
		if got := ReadMemory(func() (string, bool) { return "", false }); got != nil {
			t.Fatalf("reading = %+v, want nil on a host without /proc", *got)
		}
	})

	t.Run("[TC-PDAGENT-011] reads the real file through the default reader", func(t *testing.T) {
		read := procFile(t, "meminfo", "MemTotal:       8000000 kB\nMemAvailable:   2000000 kB\n")
		got := ReadMemory(read)
		if got == nil || got.Pct != 75 {
			t.Fatalf("reading = %+v, want 75%%", got)
		}
	})
}

// A real /proc/meminfo shape, including the two lines that are traps: SwapCached
// (starts with "Swap" and sizes nothing) and HugePages_Total (a real line with no
// `kB` unit). Swap answers 25% here while memory answers 50% from the SAME text,
// so a parser wired to the wrong keys cannot land on the right number by accident.
const meminfoWithSwap = `MemTotal:       8000000 kB
MemFree:         100000 kB
MemAvailable:   4000000 kB
Buffers:          50000 kB
Cached:         3000000 kB
SwapCached:      200000 kB
SwapTotal:      2000000 kB
SwapFree:       1500000 kB
HugePages_Total:       0
`

func TestSwap(t *testing.T) {
	t.Run("[TC-PDAGENT-125] reads the swap keys, not the memory keys beside them", func(t *testing.T) {
		reading := parseMeminfoSwap(meminfoWithSwap)
		if reading == nil {
			t.Fatal("meminfo did not parse")
		}
		// 2000000 kB total, 1500000 kB free -> 500000 kB used -> 512000000 B, 25%.
		if reading.TotalBytes != 2_048_000_000 || reading.UsedBytes != 512_000_000 || reading.Pct != 25 {
			t.Fatalf("reading = %+v, want used 512000000 / total 2048000000 / 25%%", *reading)
		}
	})

	t.Run("[TC-PDAGENT-125] does not count SwapCached as part of the swap area", func(t *testing.T) {
		// SwapCached is 200000 kB. Folded into free the answer would be 15%; folded
		// into total it would be 23%. Both are far enough from 25% to be visible.
		if reading := parseMeminfoSwap(meminfoWithSwap); reading.Pct != 25 {
			t.Fatalf("pct = %d, want 25 — SwapCached leaked into the arithmetic", reading.Pct)
		}
	})

	t.Run("[TC-PDAGENT-125] a host with swap turned off is measured, not unmeasured", func(t *testing.T) {
		// Every container and every server built with swap off reports exactly this,
		// and it is a successful reading: nothing is swapped because there is nowhere
		// to swap to. nil here would make it indistinguishable from a /proc nobody
		// could read, and from an agent too old to know the word.
		reading := parseMeminfoSwap("SwapTotal:             0 kB\nSwapFree:              0 kB\n")
		if reading == nil {
			t.Fatal("reading = nil, want a measured 0/0 — a swapless host was looked at")
		}
		if reading.TotalBytes != 0 || reading.UsedBytes != 0 || reading.Pct != 0 {
			t.Fatalf("reading = %+v, want 0/0 at 0%%", *reading)
		}
	})

	t.Run("[TC-PDAGENT-125] refuses a meminfo that never mentions swap", func(t *testing.T) {
		// Kernels print the swap lines even with CONFIG_SWAP=n, so their absence is a
		// masked or truncated /proc — not a host with swap turned off.
		for name, text := range map[string]string{
			"memory only":    "MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n",
			"total alone":    "SwapTotal: 2000000 kB\n",
			"free alone":     "SwapFree: 1500000 kB\n",
			"garbage":        "garbage",
			"negative total": "SwapTotal:      -1 kB\nSwapFree:       0 kB\n",
		} {
			if got := parseMeminfoSwap(text); got != nil {
				t.Fatalf("%s: parsed %+v, want nil", name, *got)
			}
		}
	})

	t.Run("[TC-PDAGENT-125] reports nil when there is no /proc/meminfo at all", func(t *testing.T) {
		// ⚠ THIS CANNOT FAIL ON LINUX. The host fall-through it guards is behind
		// runtime.GOOS == "darwin", so on Linux the broken code returns nil anyway.
		// Same blind spot as its memory twin above; it bites on a Mac, which is where
		// the fall-through exists.
		if got := ReadSwap(func() (string, bool) { return "", false }); got != nil {
			t.Fatalf("reading = %+v, want nil on a host without /proc", *got)
		}
	})

	t.Run("[TC-PDAGENT-125] reads the real file through the default reader", func(t *testing.T) {
		read := procFile(t, "meminfo", "SwapTotal:      4000000 kB\nSwapFree:       1000000 kB\n")
		got := ReadSwap(read)
		if got == nil || got.Pct != 75 {
			t.Fatalf("reading = %+v, want 75%%", got)
		}
	})

	t.Run("[TC-PDAGENT-125] a memory failure does not take swap with it", func(t *testing.T) {
		// The reason swap is its own seam. A kernel too old for MemAvailable makes
		// parseMeminfo return nil, and a shared reading would drag a perfectly
		// readable SwapTotal down with it.
		got := Resource(t.Context(), ResourceReaders{
			Memory: func() *MemoryReading { return nil },
			Swap:   func() *SwapReading { return &SwapReading{UsedBytes: 1 << 30, TotalBytes: 4 << 30, Pct: 25} },
			Disk:   func(context.Context) *DiskReading { return nil },
		})
		if got.MemPct != nil {
			t.Fatalf("memPct = %v, want nil", got.MemPct)
		}
		if derefInt(got.SwapPct) != 25 || got.SwapTotalBytes == nil {
			t.Fatalf("swap = %v / %v, want 25%% and its bytes", got.SwapPct, got.SwapTotalBytes)
		}
	})
}

func TestDisk(t *testing.T) {
	t.Run("[TC-PDAGENT-012] parses df -Pk output for the root filesystem", func(t *testing.T) {
		text := "Filesystem     1024-blocks     Used Available Capacity Mounted on\n" +
			"/dev/root         101583232 76187424  25395808      76% /\n"
		got := parseDf(text)
		if got == nil {
			t.Fatal("df did not parse")
		}
		if got.UsedBytes != 76_187_424*1024 || got.TotalBytes != 101_583_232*1024 || got.Pct != 75 {
			t.Fatalf("reading = %+v, want 75%% of 101583232 blocks", *got)
		}
	})

	t.Run("[TC-PDAGENT-012] returns nil when df printed nothing usable", func(t *testing.T) {
		for _, text := range []string{"", "Filesystem 1024-blocks Used\n", "/dev/root x y z 0% /\n"} {
			if got := parseDf(text); got != nil {
				t.Fatalf("parsed %+v from %q", *got, text)
			}
		}
	})

	t.Run("[TC-PDAGENT-012] reports nil rather than 0 when df fails", func(t *testing.T) {
		// A path that cannot be stat'ed makes df exit non-zero: the disk is not
		// 0% full, it is unmeasured, and the card must say so.
		if got := ReadDisk(t.Context(), "/pdmux-no-such-path", 4_000); got != nil {
			t.Fatalf("reading = %+v, want nil", *got)
		}
	})
}

func TestResourceAssembly(t *testing.T) {
	readers := ResourceReaders{
		CPU: NewCPUMeter(CPUMeterOptions{
			ReadStat: func() (string, bool) { return "", false },
			Load:     func() (float64, bool) { return 1, true }, CoreCount: 2,
		}),
		Memory: func() *MemoryReading {
			return &MemoryReading{UsedBytes: 4 << 30, TotalBytes: 8 << 30, Pct: 50}
		},
		Swap: func() *SwapReading {
			return &SwapReading{UsedBytes: 1 << 30, TotalBytes: 2 << 30, Pct: 50}
		},
		Disk: func(context.Context) *DiskReading {
			return &DiskReading{UsedBytes: 3 << 30, TotalBytes: 4 << 30, Pct: 75}
		},
		Load:      func() (float64, bool) { return 1.25, true },
		UptimeSec: func() (int64, bool) { return 86_400, true },
	}

	t.Run("[TC-PDAGENT-010][TC-PDAGENT-011][TC-PDAGENT-012] carries absolute bytes alongside the percentages", func(t *testing.T) {
		got := Resource(t.Context(), readers)
		if derefInt(got.CPUPct) != 50 || derefInt(got.MemPct) != 50 || derefInt(got.DiskPct) != 75 {
			t.Fatalf("percentages = %v/%v/%v", derefInt(got.CPUPct), derefInt(got.MemPct), derefInt(got.DiskPct))
		}
		// A tooltip wants "4Gi/8Gi", and a percentage alone cannot produce it.
		if got.MemUsedBytes == nil || *got.MemUsedBytes != float64(4<<30) || got.MemTotalBytes == nil {
			t.Fatalf("memory bytes = %v/%v", got.MemUsedBytes, got.MemTotalBytes)
		}
		if got.DiskUsedBytes == nil || got.DiskTotalBytes == nil {
			t.Fatalf("disk bytes = %v/%v", got.DiskUsedBytes, got.DiskTotalBytes)
		}
		if derefInt(got.SwapPct) != 50 || got.SwapUsedBytes == nil || got.SwapTotalBytes == nil {
			t.Fatalf("swap = %v at %v/%v", got.SwapPct, got.SwapUsedBytes, got.SwapTotalBytes)
		}
		if got.Load1 == nil || *got.Load1 != 1.25 {
			t.Fatalf("load1 = %v, want 1.25", got.Load1)
		}
		if got.UptimeSec == nil || *got.UptimeSec != 86_400 {
			t.Fatalf("uptime = %v, want the host's, not the agent's", got.UptimeSec)
		}
	})

	t.Run("[TC-PDAGENT-010][TC-PDAGENT-011][TC-PDAGENT-012] leaves every unmeasurable field nil", func(t *testing.T) {
		got := Resource(t.Context(), ResourceReaders{
			Memory:    func() *MemoryReading { return nil },
			Swap:      func() *SwapReading { return nil },
			Disk:      func(context.Context) *DiskReading { return nil },
			Load:      func() (float64, bool) { return 0, false },
			UptimeSec: func() (int64, bool) { return 0, false },
		})
		for name, value := range map[string]any{
			"cpuPct": got.CPUPct, "memPct": got.MemPct, "diskPct": got.DiskPct,
			"memUsedBytes": got.MemUsedBytes, "memTotalBytes": got.MemTotalBytes,
			"diskUsedBytes": got.DiskUsedBytes, "diskTotalBytes": got.DiskTotalBytes,
			"swapPct": got.SwapPct, "swapUsedBytes": got.SwapUsedBytes, "swapTotalBytes": got.SwapTotalBytes,
			"load1": got.Load1, "uptimeSec": got.UptimeSec,
		} {
			if !isNilPointer(value) {
				t.Fatalf("%s = %v, want nil — 0 would draw a healthy idle host", name, value)
			}
		}
	})

	// No TC: the integer-percent rule is contract-level (pdmux-work/docs/CONTRACTS.md C3),
	// and it is checked here because this is where every percentage is produced.
	t.Run("rounds a percentage to the integer the contract requires", func(t *testing.T) {
		if got := clampPct(42.5); got != 43 {
			t.Fatalf("clampPct(42.5) = %d, want 43 — a float fails the whole frame", got)
		}
		if got := clampPct(42.4); got != 42 {
			t.Fatalf("clampPct(42.4) = %d, want 42", got)
		}
		// df reports over 100% when reserved blocks are in use; a `percent` above
		// the cap would cost the heartbeat rather than the digit.
		if got := clampPct(101.2); got != 100 {
			t.Fatalf("clampPct(101.2) = %d, want 100", got)
		}
		if got := clampPct(-3); got != 0 {
			t.Fatalf("clampPct(-3) = %d, want 0", got)
		}
	})
}

func derefInt(value *int) int {
	if value == nil {
		return -1
	}
	return *value
}

// isNilPointer answers "was this field left unmeasured" for the mixed-pointer
// table above, where the values are *int, *float64 and *int64 at once.
func isNilPointer(value any) bool {
	switch typed := value.(type) {
	case *int:
		return typed == nil
	case *int64:
		return typed == nil
	case *float64:
		return typed == nil
	default:
		return false
	}
}
