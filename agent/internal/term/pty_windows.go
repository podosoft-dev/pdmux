package term

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/UserExistsError/conpty"
)

// Spawn uses the operating system's pseudoconsole; no WSL or tmux is required.
func Spawn(spec Spec) (Process, error) {
	file, err := exec.LookPath(spec.File)
	if err != nil {
		return nil, err
	}
	argv := append([]string{file}, spec.Args...)
	for i := range argv {
		argv[i] = syscall.EscapeArg(argv[i])
	}
	directory := spec.Dir
	if directory == "" {
		directory = HomeDir()
	}
	environment := spec.Env
	if environment == nil {
		environment = os.Environ()
	}
	cols, rows := clampWindow(spec.Cols, spec.Rows)
	console, err := conpty.Start(strings.Join(argv, " "), conpty.ConPtyDimensions(int(cols), int(rows)), conpty.ConPtyWorkDir(directory), conpty.ConPtyEnv(environment))
	if err != nil {
		return nil, err
	}
	p := &windowsProcess{console: console, output: make(chan []byte, outputQueueDepth), exit: make(chan *int, 1)}
	done := make(chan struct{})
	go pumpOutput(console, p.output, done)
	go func() {
		code, waitErr := console.Wait(context.Background())
		// ClosePseudoConsole may wait for its output pipe to drain on Windows 10.
		// Keep the independent reader running throughout shutdown.
		p.close.Do(func() { _ = console.Close() })
		<-done
		var status *int
		if waitErr == nil && !p.killed.Load() {
			value := int(code)
			status = &value
		}
		p.exit <- status
		close(p.exit)
	}()
	return p, nil
}

type windowsProcess struct {
	console *conpty.ConPty
	output  chan []byte
	exit    chan *int
	close   sync.Once
	killed  atomic.Bool
}

func (p *windowsProcess) Pid() *int             { pid := p.console.Pid(); return &pid }
func (p *windowsProcess) Output() <-chan []byte { return p.output }
func (p *windowsProcess) Exit() <-chan *int     { return p.exit }
func (p *windowsProcess) Write(data string) error {
	_, err := p.console.Write([]byte(data))
	return err
}
func (p *windowsProcess) Resize(cols, rows int) error {
	c, r := clampWindow(cols, rows)
	return p.console.Resize(int(c), int(r))
}
func (p *windowsProcess) Kill() {
	p.killed.Store(true)
	// All console clients receive CTRL_CLOSE_EVENT. Only this pseudoconsole is
	// closed; no PID lookup can reach another terminal after a PID is reused.
	go p.close.Do(func() { _ = p.console.Close() })
}

func HomeDir() string { home, _ := os.UserHomeDir(); return home }
