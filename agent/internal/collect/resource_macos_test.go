package collect

import (
	"runtime"
	"testing"
)

// A real `vm_stat` header plus the lines the memory figure is built from. Page
// size 4096 keeps every expected byte count checkable by hand.
const vmStatFixture = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                     1000.
Pages active:                                   4000.
Pages inactive:                                 2000.
Pages speculative:                               500.
Pages throttled:                                   0.
Pages wired down:                               3000.
Pages purgeable:                                 100.
"Translation faults":                        9999999.
`

func TestParseSysctlLoadavg(t *testing.T) {
	t.Run("[TC-PDAGENT-107] reads load1 out of the brace triple", func(t *testing.T) {
		got, ok := parseSysctlLoadavg("{ 7.76 5.43 4.50 }\n")
		if !ok || got != 7.76 {
			t.Fatalf("load1 = %v, %v; want 7.76, true", got, ok)
		}
	})

	t.Run("[TC-PDAGENT-107] refuses text that is not a load triple", func(t *testing.T) {
		// `sysctl` prints a diagnostic to stdout for an unknown oid on some systems,
		// and a parsed-as-zero load would report an idle machine — the one lie this
		// package is written not to tell.
		for _, text := range []string{"", "{}", "{ nope }", "sysctl: unknown oid"} {
			if got, ok := parseSysctlLoadavg(text); ok {
				t.Fatalf("parsed %q as %v, want it refused", text, got)
			}
		}
	})
}

func TestParseSysctlBoottime(t *testing.T) {
	t.Run("[TC-PDAGENT-107] reads the boot second out of the struct", func(t *testing.T) {
		got, ok := parseSysctlBoottime("{ sec = 1784361150, usec = 38040 } Sat Jul 18 16:52:30 2026\n")
		if !ok || got != 1784361150 {
			t.Fatalf("boot = %v, %v; want 1784361150, true", got, ok)
		}
	})

	t.Run("[TC-PDAGENT-107] refuses a struct it cannot find the seconds in", func(t *testing.T) {
		for _, text := range []string{"", "{ usec = 1 }", "{ sec = notanumber }", "{ sec = 0 }"} {
			if got, ok := parseSysctlBoottime(text); ok {
				t.Fatalf("parsed %q as %v, want it refused", text, got)
			}
		}
	})
}

func TestParseVMStatPages(t *testing.T) {
	t.Run("[TC-PDAGENT-107] converts pages to bytes using the header's page size", func(t *testing.T) {
		pages, ok := parseVMStatPages(vmStatFixture)
		if !ok {
			t.Fatal("refused a real vm_stat")
		}
		for label, want := range map[string]int64{
			"free":        1000 * 4096,
			"active":      4000 * 4096,
			"inactive":    2000 * 4096,
			"speculative": 500 * 4096,
			"wired down":  3000 * 4096,
			"purgeable":   100 * 4096,
		} {
			if pages[label] != want {
				t.Errorf("%s = %d bytes, want %d", label, pages[label], want)
			}
		}
	})

	t.Run("[TC-PDAGENT-107] refuses output with no page size", func(t *testing.T) {
		// Without it every figure would silently be zero, which reads as a host with
		// no memory in use rather than as a failed measurement.
		if _, ok := parseVMStatPages("Pages free: 1000.\n"); ok {
			t.Fatal("accepted vm_stat with no page size")
		}
	})
}

func TestDarwinMemory(t *testing.T) {
	t.Run("[TC-PDAGENT-107] counts reclaimable pages as available, mirroring MemAvailable", func(t *testing.T) {
		// available = free + inactive + speculative + purgeable
		//           = (1000 + 2000 + 500 + 100) * 4096 = 14,745,600
		// used      = 100,000,000 - 14,745,600 = 85,254,400  → 85%
		got := darwinMemory("100000000\n", vmStatFixture)
		if got == nil {
			t.Fatal("no reading")
		}
		if got.TotalBytes != 100_000_000 || got.UsedBytes != 85_254_400 || got.Pct != 85 {
			t.Fatalf("reading = %+v; want total 100000000, used 85254400, pct 85", *got)
		}
	})

	t.Run("[TC-PDAGENT-107] does not count wired or active as reclaimable", func(t *testing.T) {
		// The control for the case above: if active/wired were credited back, used
		// would fall by (4000+3000)*4096 and the figure would flatter every Mac.
		got := darwinMemory("100000000\n", vmStatFixture)
		if got == nil {
			t.Fatal("no reading")
		}
		if wrong := int64(100_000_000 - (1000+2000+500+100+4000+3000)*4096); got.UsedBytes == wrong {
			t.Fatalf("used %d counts active and wired as available", got.UsedBytes)
		}
	})

	t.Run("[TC-PDAGENT-107] refuses a total it cannot read", func(t *testing.T) {
		for _, memsize := range []string{"", "0", "not-a-number"} {
			if got := darwinMemory(memsize, vmStatFixture); got != nil {
				t.Fatalf("memsize %q produced %+v, want nil", memsize, *got)
			}
		}
	})
}

func TestReadDarwinUptimeSec(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("shells out to sysctl(8)")
	}

	t.Run("[TC-PDAGENT-107] reports the HOST's uptime, from boot to now", func(t *testing.T) {
		// Pin the clock: boottime alone has no stable expectation, and this is the
		// arithmetic that makes an agent restarted a minute ago still report a box
		// that has been up for a month.
		original := nowUnix
		t.Cleanup(func() { nowUnix = original })

		boot, ok := parseSysctlBoottime(mustRun(t, "sysctl", "-n", "kern.boottime"))
		if !ok {
			t.Fatal("could not read kern.boottime")
		}
		nowUnix = func() int64 { return boot + 90_000 }
		got, ok := readDarwinUptimeSec()
		if !ok || got != 90_000 {
			t.Fatalf("uptime = %v, %v; want 90000, true", got, ok)
		}
	})

	t.Run("[TC-PDAGENT-107] refuses a clock that moved back past boot", func(t *testing.T) {
		original := nowUnix
		t.Cleanup(func() { nowUnix = original })
		nowUnix = func() int64 { return 1 }
		if got, ok := readDarwinUptimeSec(); ok {
			t.Fatalf("uptime = %v, want it refused", got)
		}
	})
}

// The whole point, end to end: on a Mac the four metrics that used to be "not
// measured" are measured, and CPU comes back with them through the load fallback
// that was already there.
func TestDarwinHostReadings(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("reads this host through macOS tools")
	}

	t.Run("[TC-PDAGENT-107] load, memory and uptime answer on a host with no /proc", func(t *testing.T) {
		load, ok := ReadLoad1()
		if !ok || load < 0 {
			t.Fatalf("load1 = %v, %v; want a real load", load, ok)
		}

		memory := ReadMemory(nil)
		if memory == nil {
			t.Fatal("memory not measured")
		}
		if memory.TotalBytes <= 0 || memory.UsedBytes <= 0 || memory.UsedBytes > memory.TotalBytes {
			t.Fatalf("memory = %+v; want 0 < used <= total", *memory)
		}
		if memory.Pct < 1 || memory.Pct > 100 {
			t.Fatalf("memory pct = %d; want a plausible percentage", memory.Pct)
		}

		uptime, ok := ReadUptimeSec()
		if !ok || uptime <= 0 {
			t.Fatalf("uptime = %v, %v; want a real uptime", uptime, ok)
		}
	})

	t.Run("[TC-PDAGENT-107] CPU reports through the load fallback, with no second sample", func(t *testing.T) {
		// There is no /proc/stat here, so this is the first call AND the answer —
		// unlike the Linux path, which must return nil until it has two samples.
		if got := NewCPUMeter(CPUMeterOptions{}).Sample(); got == nil {
			t.Fatal("CPU not measured on a host whose load is readable")
		} else if *got < 0 || *got > 100 {
			t.Fatalf("cpu = %d; want 0..100", *got)
		}
	})
}

// mustRun is the test's own tiny shell-out, so a fixture can be taken from the
// machine the darwin-gated specs are actually running on.
func mustRun(t *testing.T, file string, args ...string) string {
	t.Helper()
	text, ok := runDarwinTool(file, args)
	if !ok {
		t.Fatalf("%s %v failed", file, args)
	}
	return text
}
