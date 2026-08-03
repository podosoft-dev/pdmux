//go:build !unix

package cli

import "runtime"

// runtimeGOOS is the platform this binary was built for.
var runtimeGOOS = runtime.GOOS

// DirWritableBy is unreachable on a platform with neither systemd nor launchd —
// PlanInstall refuses such a host before it asks. It exists so the package still
// compiles there, because `pdmux-agent doctor` and `verify` are useful on a
// machine this installer will not touch.
func DirWritableBy(string, string) bool { return false }
