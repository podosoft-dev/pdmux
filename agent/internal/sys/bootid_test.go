package sys

import (
	"errors"
	"runtime"
	"testing"
)

func TestBootID(t *testing.T) {
	t.Run("[TC-PDAGENT-131] each platform's boot identity is read from its own source", func(t *testing.T) {
		file := func(path string) ([]byte, error) {
			if path != "/proc/sys/kernel/random/boot_id" {
				t.Fatalf("read %s", path)
			}
			return []byte("3f2a9c1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b\n"), nil
		}
		sysctl := func() string { return "6D2C4E1A-0B3F-4A5E-8C7D-9E0F1A2B3C4D\n" }
		if got := readBootID("linux", file, sysctl); got != "3f2a9c1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b" {
			t.Fatalf("linux = %q", got)
		}
		if got := readBootID("darwin", file, sysctl); got != "6D2C4E1A-0B3F-4A5E-8C7D-9E0F1A2B3C4D" {
			t.Fatalf("darwin = %q", got)
		}
		if got := readBootID("windows", file, sysctl); got != "" {
			t.Fatalf("windows = %q, want unknown", got)
		}
	})

	t.Run("[TC-PDAGENT-131] an unreadable or malformed identity is unknown, never a guess", func(t *testing.T) {
		failing := func(string) ([]byte, error) { return nil, errors.New("masked /proc") }
		if got := readBootID("linux", failing, nil); got != "" {
			t.Fatalf("unreadable = %q", got)
		}
		for _, output := range []string{"", "sysctl: unknown oid 'kern.bootsessionuuid'", "../../etc"} {
			if got := readBootID("darwin", nil, func() string { return output }); got != "" {
				t.Fatalf("%q read as %q", output, got)
			}
		}
	})

	t.Run("[TC-PDAGENT-131] this host reports a stable identity where the platform has one", func(t *testing.T) {
		if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
			t.Skip("no boot identity on this platform")
		}
		first := BootID()
		if first == "" || BootID() != first {
			t.Fatalf("BootID = %q", first)
		}
	})
}
