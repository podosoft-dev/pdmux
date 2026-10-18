package term

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func windowsOutput(t *testing.T, process Process) (<-chan string, <-chan struct{}) {
	t.Helper()
	chunks := make(chan string, 128)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer close(chunks)
		for bytes := range process.Output() {
			chunks <- string(bytes)
		}
	}()
	return chunks, done
}

func TestWindowsConPTY(t *testing.T) {
	t.Run("[TC-PDDESKTOP-018] preserves Unicode, resize and final output before exit", func(t *testing.T) {
		shell := resolveShell(os.Getenv)
		process, err := Spawn(Spec{File: shell.File, Args: []string{"-NoLogo", "-NoProfile", "-Command", "$s = [Console]::ReadLine(); Write-Output ('RESULT:' + $s); Write-Output ('SIZE:' + [Console]::WindowWidth); exit 7"}, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer process.Kill()
		chunks, done := windowsOutput(t, process)
		if err := process.Resize(112, 36); err != nil {
			t.Fatal(err)
		}
		if err := process.Write("PDMux \uD55C\uAE00🙂\r\n"); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		var output strings.Builder
		for {
			select {
			case chunk, ok := <-chunks:
				if !ok {
					goto drained
				}
				output.WriteString(chunk)
			case <-ctx.Done():
				t.Fatalf("timeout: %q", output.String())
			}
		}
	drained:
		<-done
		select {
		case code := <-process.Exit():
			if code == nil || *code != 7 {
				t.Fatalf("exit: %v", code)
			}
		case <-ctx.Done():
			t.Fatal("missing exit after output drained")
		}
		if !strings.Contains(output.String(), "RESULT:PDMux \uD55C\uAE00🙂") || !strings.Contains(output.String(), "SIZE:112") {
			t.Fatalf("output: %q", output.String())
		}
	})
	t.Run("[TC-PDDESKTOP-018] closes only its console and reports a killed process", func(t *testing.T) {
		shell := resolveShell(os.Getenv)
		process, err := Spawn(Spec{File: shell.File, Args: []string{"-NoLogo", "-NoProfile", "-Command", "Write-Output READY; Start-Sleep 120"}, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		chunks, _ := windowsOutput(t, process)
		timer := time.NewTimer(20 * time.Second)
		defer timer.Stop()
		var output string
		for !strings.Contains(output, "READY") {
			select {
			case chunk := <-chunks:
				output += chunk
			case <-timer.C:
				t.Fatal("not ready")
			}
		}
		process.Kill()
		process.Kill()
		// Drain concurrently, including output emitted during ClosePseudoConsole.
		go func() {
			for range chunks {
			}
		}()
		select {
		case code := <-process.Exit():
			if code != nil {
				t.Fatalf("killed code: %d", *code)
			}
		case <-timer.C:
			t.Fatal("console survived Kill")
		}
	})
}
