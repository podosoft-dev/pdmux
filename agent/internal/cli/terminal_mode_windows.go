package cli

import "golang.org/x/sys/windows"

// The input handle's raw mode does not enable ANSI rendering on the output
// screen buffer. Restore the caller's output mode after the viewer detaches.
func enableOutputVT(fd int) (func(), error) {
	handle := windows.Handle(fd)
	var previous uint32
	if err := windows.GetConsoleMode(handle, &previous); err != nil {
		return nil, err
	}
	mode := previous | windows.ENABLE_PROCESSED_OUTPUT | windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING | windows.DISABLE_NEWLINE_AUTO_RETURN
	if err := windows.SetConsoleMode(handle, mode); err != nil {
		return nil, err
	}
	return func() { _ = windows.SetConsoleMode(handle, previous) }, nil
}
