package update

import (
	"errors"
	"fmt"
	"os"
)

// The swap, and the reason it is `link` + `rename` and never two renames.
//
// THE PATH MUST RESOLVE AT EVERY INSTANT. `ExecStart=/usr/local/bin/pdmux-agent`
// is a name the service manager looks up when it starts the process — possibly
// at boot, possibly minutes after the update, possibly after the power came back.
// The obvious implementation is two renames:
//
//	rename(exe, exe.bak)   // <- between these two lines the name does not exist
//	rename(exe.new, exe)
//
// A crash, a kill, or a power cut in that window leaves a host whose unit points
// at nothing. It never starts again, it cannot be told anything, and the fix
// requires physical or SSH access — the exact outcome this whole package is
// built to make unreachable, reintroduced by an implementation detail.
//
// A hard link does not remove its source. After link(exe, exe.bak) the old inode
// has two names; after rename(exe.new, exe) — a single atomic operation — the
// name `exe` refers to the new inode. There is no instant in between where it
// refers to nothing, and `exe.bak` still names the old binary, which is what
// makes the rollback in marker.go possible.
//
// WRITING IN PLACE IS NOT ONE OF THE OPTIONS. The kernel returns ETXTBSY for a
// write to a running executable; that is not a limitation to work around, it is
// the same protection this design leans on.

// swap installs staged as exe, keeping the previous binary as backup.
func swap(exe, staged, backup string) error {
	if _, err := os.Stat(staged); err != nil {
		return fmt.Errorf("the staged binary is missing: %w", err)
	}
	// A leftover .bak from a previous update: link(2) fails with EEXIST, so it has
	// to go first. Removing a backup we are about to replace is safe — the binary
	// it names is the one still running, and it keeps its second name (`exe`)
	// until the rename below.
	if err := os.Remove(backup); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("cannot clear the previous backup %s: %w", backup, err)
	}
	if err := os.Link(exe, backup); err != nil {
		// No link, no rollback path. Refusing here leaves the old binary installed
		// and the host exactly as it was, which is the correct failure.
		return fmt.Errorf("cannot back up the current binary: %w", err)
	}
	if err := os.Rename(staged, exe); err != nil {
		// The backup is now a stray name for the binary that is still installed.
		// Removing it keeps the directory honest for the next attempt.
		_ = os.Remove(backup)
		return fmt.Errorf("cannot install the new binary: %w", err)
	}
	return nil
}

// restore puts the backup back, by the same link-then-rename argument.
//
// `rename(backup, exe)` would also be atomic and would also leave the path always
// resolving — but it CONSUMES the backup. Keeping `.bak` means a second rollback
// (or a human arriving later to ask what happened) still has the binary that was
// running before the update, so the extra link is worth its cost.
func restore(exe, backup string) error {
	if _, err := os.Stat(backup); err != nil {
		return fmt.Errorf("no backup to restore: %w", err)
	}
	staging := exe + ".restore"
	if err := os.Remove(staging); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("cannot clear %s: %w", staging, err)
	}
	if err := os.Link(backup, staging); err != nil {
		return fmt.Errorf("cannot stage the backup: %w", err)
	}
	if err := os.Rename(staging, exe); err != nil {
		_ = os.Remove(staging)
		return fmt.Errorf("cannot restore the backup: %w", err)
	}
	return nil
}
