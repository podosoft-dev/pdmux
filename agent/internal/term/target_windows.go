package term

import (
	"os/exec"
	"path/filepath"
)

// PowerShell 7 is preferred when installed; Windows PowerShell ships with the OS.
func resolveShell(getenv func(string) string) Resolved {
	shell, err := exec.LookPath("pwsh.exe")
	if err != nil {
		shell = filepath.Join(getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	}
	return Resolved{File: shell, Args: []string{"-NoLogo"}, Label: "shell"}
}
