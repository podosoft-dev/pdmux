//go:build !windows

package session

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

func secureDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Sys().(*syscall.Stat_t).Uid != uint32(os.Getuid()) {
		return fmt.Errorf("SESSION_DIRECTORY_OWNER_INVALID")
	}
	return os.Chmod(path, 0o700)
}
func secureFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	return os.Chmod(path, 0o600|info.Mode()&0o100)
}
func executableSuffix() string { return "" }
func detach(command *exec.Cmd) { command.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
func lockEngine(root string) (func(), error) {
	file, err := os.OpenFile(filepath.Join(root, "engine.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("SESSION_ENGINE_ALREADY_RUNNING")
	}
	return func() { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN); _ = file.Close() }, nil
}
func listen(root string) (net.Listener, string, error) {
	directory := filepath.Join("/tmp", fmt.Sprintf("pdmux-session-%d", os.Getuid()))
	if err := secureDirectory(directory); err != nil {
		return nil, "", err
	}
	hash := sha256.Sum256([]byte(root))
	path := filepath.Join(directory, fmt.Sprintf("%x.sock", hash[:12]))
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err == nil {
		err = os.Chmod(path, 0o600)
	}
	return listener, path, err
}
func dial(ctx context.Context, address string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "unix", address)
}
