package sys

import (
	"context"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
)

// bootIDPattern is what a boot identity may look like. Both kernels hand out a
// UUID; the class is a little wider so a kernel that formats it differently still
// counts, and narrow enough that nothing else (an error sentence, a path) does.
var bootIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

var (
	bootOnce  sync.Once
	bootValue string
)

// BootID identifies the current boot of this machine, or "" when the platform has
// no such identity or it could not be read.
//
// ⚠ EMPTY MEANS "UNKNOWN", AND EVERY CALLER MUST TREAT IT AS "DO NOT RESTORE". The
// value exists to answer one question — did this machine restart since a session
// was recorded? — and a guess in either direction is worse than no answer:
// claiming a reboot that did not happen would replace a session the person can
// still reach with an empty shell.
//
// Linux reads /proc/sys/kernel/random/boot_id; macOS asks `sysctl -n
// kern.bootsessionuuid`, bounded like every other child process. The value cannot
// change while this process lives, so it is read once.
func BootID() string {
	bootOnce.Do(func() { bootValue = readBootID(runtime.GOOS, os.ReadFile, sysctlBootID) })
	return bootValue
}

func sysctlBootID() string {
	result := Run(context.Background(), "sysctl", []string{"-n", "kern.bootsessionuuid"}, Options{TimeoutMs: 2000, MaxOutput: 256})
	if result.Code != 0 {
		return ""
	}
	return result.Stdout
}

// readBootID is BootID with its sources injected, so a spec can state each
// platform's answer without depending on the machine it runs on.
func readBootID(goos string, readFile func(string) ([]byte, error), sysctl func() string) string {
	value := ""
	switch goos {
	case "linux":
		bytes, err := readFile("/proc/sys/kernel/random/boot_id")
		if err != nil {
			return ""
		}
		value = string(bytes)
	case "darwin":
		value = sysctl()
	default:
		return ""
	}
	value = strings.TrimSpace(value)
	if !bootIDPattern.MatchString(value) {
		return ""
	}
	return value
}
