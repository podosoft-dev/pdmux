package cli

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
)

// InstallIO is the applier's side of the planner/applier split. Every field is a
// function so a spec can record what an install WOULD do without owning /etc.
type InstallIO struct {
	// Mkdir creates path (and parents) with mode. enforce means "chmod it even if
	// it already existed" — see InstallAction.EnforceMode.
	Mkdir func(path string, mode fs.FileMode, enforce bool) error
	// WriteFile writes content to path with mode, replacing what is there.
	WriteFile func(path, content string, mode fs.FileMode) error
	// CopyFile copies source to dest with mode.
	CopyFile func(source, dest string, mode fs.FileMode) error
	// Chown sets the owner (and group, when non-empty) by NAME. Names rather than
	// ids because that is what the plan printed and what the unit file says.
	Chown func(path, owner, group string) error
}

// DefaultInstallIO applies a plan to the real filesystem.
func DefaultInstallIO() InstallIO {
	return InstallIO{
		Mkdir:     mkdirAll,
		WriteFile: writeFile,
		CopyFile:  copyFile,
		Chown:     chown,
	}
}

// ApplyPlan performs the plan in order.
//
// It stops at the first failure and says which step failed. A partially applied
// install is not "success with a warning": the next thing the operator does is
// paste the enable commands, and they must not enable a unit whose config file
// never landed.
func ApplyPlan(plan InstallPlan, io InstallIO) error {
	for _, action := range plan.Actions {
		var err error
		switch action.Kind {
		case ActionMkdir:
			err = io.Mkdir(action.Path, action.Mode, action.EnforceMode)
		case ActionWrite:
			err = io.WriteFile(action.Path, action.Content, action.Mode)
		case ActionCopy:
			err = io.CopyFile(action.Source, action.Path, action.Mode)
		default:
			err = fmt.Errorf("unknown install action %q", action.Kind)
		}
		if err != nil {
			return fmt.Errorf("%s %s: %w", action.Kind, action.Path, err)
		}
		if action.Owner == "" || io.Chown == nil {
			continue
		}
		if err := io.Chown(action.Path, action.Owner, action.Group); err != nil {
			return fmt.Errorf("chown %s to %s: %w", action.Path, action.Owner, err)
		}
	}
	return nil
}

func mkdirAll(path string, mode fs.FileMode, enforce bool) error {
	// Remember which ancestors do not exist yet. MkdirAll creates them too, with
	// the mode masked by the umask -- and the installer runs under `umask 077`, on
	// purpose, so a credential can never be written world-readable. The parent of
	// the exec directory then lands at 0700 root while the plan said 0755, and a
	// unit running as a non-root user cannot traverse it: the service dies with
	// 203/EXEC "Permission denied" and the binary inside looks perfectly fine.
	//
	// Measured on a fresh install: /opt/pdmux 0700 root, /opt/pdmux/bin 0755, and
	// an agent that had already passed its own connectivity check as root.
	missing := createdAncestors(path)
	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	if !enforce {
		return nil
	}
	// MkdirAll's mode is masked by the umask and ignored entirely for a directory
	// that already exists, so an inherited 0755 would survive a plan that says
	// 0700. Chmod is the only way to state the mode we printed -- for every
	// directory this call brought into existence, not just the last one.
	for _, dir := range missing {
		if err := os.Chmod(dir, mode); err != nil {
			return err
		}
	}
	return os.Chmod(path, mode)
}

// createdAncestors lists the ancestors of path that do not exist yet, outermost
// first, so they can be given the mode the plan asked for after MkdirAll.
func createdAncestors(path string) []string {
	var missing []string
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		if dir == "" || dir == "." || dir == string(filepath.Separator) {
			break
		}
		if _, err := os.Stat(dir); err == nil {
			break
		}
		missing = append([]string{dir}, missing...)
		if parent := filepath.Dir(dir); parent == dir {
			break
		}
	}
	return missing
}

func writeFile(path, content string, mode fs.FileMode) error {
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		return err
	}
	// WriteFile's perm applies only when it CREATES the file, and is masked by the
	// umask even then — so re-running install over an agent.json that was once
	// written 0644 would leave the credential world-readable while the plan
	// claimed 0600. (The TypeScript installer has the same latent bug; it is fixed
	// here rather than ported.)
	return os.Chmod(path, mode)
}

// copyFile writes through a temporary file and renames.
//
// Not because of crash-atomicity (though that too): writing directly to a binary
// that is currently EXECUTING fails with ETXTBSY on Linux, and re-running install
// while the agent is up is an ordinary thing to do. Rename swaps the directory
// entry instead, which the running process does not notice.
func copyFile(source, dest string, mode fs.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()

	temp := dest + ".new"
	out, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(temp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(temp)
		return err
	}
	if err := os.Chmod(temp, mode); err != nil {
		os.Remove(temp)
		return err
	}
	if err := os.Rename(temp, dest); err != nil {
		os.Remove(temp)
		return err
	}
	return nil
}

func chown(path, owner, group string) error {
	uid, gid, err := lookupIDs(owner, group)
	if err != nil {
		return err
	}
	return os.Chown(path, uid, gid)
}

func lookupIDs(owner, group string) (int, int, error) {
	account, err := user.Lookup(owner)
	if err != nil {
		return 0, 0, err
	}
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return 0, 0, fmt.Errorf("user %s has a non-numeric uid %q", owner, account.Uid)
	}
	gid, err := strconv.Atoi(account.Gid)
	if err != nil {
		return 0, 0, fmt.Errorf("user %s has a non-numeric gid %q", owner, account.Gid)
	}
	if group == "" {
		return uid, gid, nil
	}
	resolved, err := user.LookupGroup(group)
	if err != nil {
		return 0, 0, err
	}
	gid, err = strconv.Atoi(resolved.Gid)
	if err != nil {
		return 0, 0, fmt.Errorf("group %s has a non-numeric gid %q", group, resolved.Gid)
	}
	return uid, gid, nil
}

// ExecutablePath is the absolute path of the running binary — what the unit will
// name in ExecStart unless placeExec relocates it.
//
// EvalSymlinks matters here: a distribution that installs the binary behind a
// symlink (or /usr/local/bin/pdmux-agent -> /opt/pdmux/…) would otherwise put the
// LINK in the unit, and a self-update that replaces the link's target leaves the
// unit pointing at whatever the link now says — including nothing.
func ExecutablePath() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	return filepath.Abs(path)
}
