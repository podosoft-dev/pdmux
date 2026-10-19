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

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func descriptor() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return "D:P(A;;GA;;;SY)(A;;GA;;;" + user.User.Sid.String() + ")", nil
}
func protect(path string) error {
	sddl, err := descriptor()
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}
func secureDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("SESSION_DIRECTORY_INVALID")
	}
	return protect(path)
}
func secureFile(path string) error { return protect(path) }
func executableSuffix() string     { return ".exe" }
func detach(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000008 | windows.CREATE_NEW_PROCESS_GROUP}
}
func lockEngine(root string) (func(), error) {
	path, err := windows.UTF16PtrFromString(filepath.Join(root, "engine.lock"))
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(path, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	overlap := new(windows.Overlapped)
	if err := windows.LockFileEx(handle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlap); err != nil {
		windows.CloseHandle(handle)
		return nil, fmt.Errorf("SESSION_ENGINE_ALREADY_RUNNING")
	}
	return func() { _ = windows.UnlockFileEx(handle, 0, 1, 0, overlap); _ = windows.CloseHandle(handle) }, nil
}
func listen(root string) (net.Listener, string, error) {
	hash := sha256.Sum256([]byte(root))
	address := fmt.Sprintf(`\\.\pipe\pdmux-session-%x`, hash[:16])
	security, err := descriptor()
	if err != nil {
		return nil, "", err
	}
	listener, err := winio.ListenPipe(address, &winio.PipeConfig{SecurityDescriptor: security, InputBufferSize: 65536, OutputBufferSize: 65536})
	return listener, address, err
}
func dial(ctx context.Context, address string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, address)
}
