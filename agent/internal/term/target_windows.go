package term

import (
	"os/exec"
	"path/filepath"
)

// ConPTY transports UTF-8, while Windows console applications may start in an OEM
// code page. Configure this shell's input and output together so Console.ReadLine
// and native program pipes do not replace non-ASCII text with question marks.
const windowsShellInit = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding"

// PowerShell 7 is preferred when installed; Windows PowerShell ships with the OS.
func resolveShell(getenv func(string) string) Resolved {
	shell, err := exec.LookPath("pwsh.exe")
	if err != nil {
		shell = filepath.Join(getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	}
	return Resolved{File: shell, Args: []string{"-NoLogo", "-NoExit", "-Command", windowsShellInit}, Label: "shell"}
}
