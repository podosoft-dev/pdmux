//go:build unix

package cli

import (
	"os"
	"os/user"
	"runtime"
	"strconv"
	"syscall"
)

// runtimeGOOS is the platform this binary was built for. A variable rather than a
// direct read so the one place that needs to pretend otherwise — a spec planning
// a macOS install from Linux — sets InstallInput.GOOS instead of patching this.
var runtimeGOOS = runtime.GOOS

// DirWritableBy reports whether serviceUser (empty = the user running this
// process) may create files in dir.
//
// WHY THE MODE BITS AND NOT A WRITE PROBE: the question is about a DIFFERENT
// account than the one asking. The installer normally runs as root under sudo, so
// a probe would answer "yes, root can write here" for every directory on the
// machine — including the one the daemon's own account cannot touch, which is the
// only case this check exists to find. Owner/group/other against the service
// user's ids is the same reasoning `ls -l` invites an operator to do, and it is
// wrong only in the directions that do not matter here (ACLs, read-only mounts:
// both make it MORE restrictive than we report, and the fallback is a printed
// note either way).
func DirWritableBy(dir, serviceUser string) bool {
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}

	uid, gids := identity(serviceUser)
	if uid < 0 {
		return false
	}
	// root is not subject to the permission bits, and a system install that leaves
	// the unit running as root has bigger questions than this one.
	if uid == 0 {
		return true
	}

	mode := info.Mode().Perm()
	if uint32(uid) == stat.Uid {
		return mode&0o200 != 0
	}
	for _, gid := range gids {
		if uint32(gid) == stat.Gid {
			return mode&0o020 != 0
		}
	}
	return mode&0o002 != 0
}

// identity resolves the uid and the group ids of the account a unit will run as.
// uid is -1 when the account does not exist — which is itself a reason to say
// "not writable" and let the operator read the note.
func identity(serviceUser string) (int, []int) {
	if serviceUser == "" {
		return os.Getuid(), append([]int{os.Getgid()}, supplementaryGroups()...)
	}
	account, err := user.Lookup(serviceUser)
	if err != nil {
		return -1, nil
	}
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return -1, nil
	}
	gids := []int{}
	if primary, err := strconv.Atoi(account.Gid); err == nil {
		gids = append(gids, primary)
	}
	ids, err := account.GroupIds()
	if err != nil {
		return uid, gids
	}
	for _, raw := range ids {
		if gid, err := strconv.Atoi(raw); err == nil {
			gids = append(gids, gid)
		}
	}
	return uid, gids
}

func supplementaryGroups() []int {
	groups, err := os.Getgroups()
	if err != nil {
		return nil
	}
	return groups
}
