package session

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/semver"
)

type endpoint struct {
	Protocol int    `json:"protocol"`
	Address  string `json:"address"`
	Secret   string `json:"secret"`
	Version  string `json:"version"`
}

// Client contains paths, not server credentials. Reading a list never starts an
// engine; only an explicit create/attach operation may ensure one exists.
type Client struct {
	Root       string
	Executable string
	Version    string
	startMu    sync.Mutex
}

func scanner(connection io.Reader) *bufio.Scanner {
	s := bufio.NewScanner(connection)
	s.Buffer(make([]byte, 4096), MaxPacketBytes)
	return s
}
func readRequest(s *bufio.Scanner) (Request, error) {
	var r Request
	if !s.Scan() {
		if s.Err() != nil {
			return r, s.Err()
		}
		return r, io.EOF
	}
	err := json.Unmarshal(s.Bytes(), &r)
	if err == nil && r.Protocol != Protocol {
		err = fmt.Errorf("SESSION_PROTOCOL_UNSUPPORTED")
	}
	return r, err
}
func readReply(s *bufio.Scanner) (Reply, error) {
	var r Reply
	if !s.Scan() {
		if s.Err() != nil {
			return r, s.Err()
		}
		return r, io.EOF
	}
	err := json.Unmarshal(s.Bytes(), &r)
	if err == nil && r.Protocol != Protocol {
		err = fmt.Errorf("SESSION_PROTOCOL_UNSUPPORTED")
	}
	if err == nil && r.Error != "" {
		err = fmt.Errorf("%s", r.Error)
	}
	return r, err
}
func sendReply(connection net.Conn, reply Reply) error {
	reply.Protocol = Protocol
	_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return json.NewEncoder(connection).Encode(reply)
}

func Serve(ctx context.Context, root, version string, spawn Factory) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := secureDirectory(root); err != nil {
		return err
	}
	unlock, err := lockEngine(root)
	if err != nil {
		return err
	}
	defer unlock()
	listener, address, err := listen(root)
	if err != nil {
		return err
	}
	defer listener.Close()
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return err
	}
	metadata := endpoint{Protocol: Protocol, Address: address, Secret: hex.EncodeToString(secret[:]), Version: version}
	bytes, _ := json.Marshal(metadata)
	file := filepath.Join(root, "endpoint.json")
	temporary, err := os.CreateTemp(root, ".endpoint-")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(bytes); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := secureFile(temporary.Name()); err != nil {
		return err
	}
	if err := os.Rename(temporary.Name(), file); err != nil {
		return err
	}
	defer os.Remove(file)
	engine := NewEngine(spawn)
	defer engine.Close()
	go func() { <-ctx.Done(); _ = listener.Close() }()
	stopIdle := make(chan struct{})
	defer close(stopIdle)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopIdle:
				return
			case now := <-ticker.C:
				if engine.Idle(now) {
					_ = listener.Close()
					return
				}
			}
		}
	}()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || engine.Idle(time.Now()) {
				return nil
			}
			return err
		}
		go serveConnection(connection, metadata, engine, cancel)
	}
}

func serveConnection(connection net.Conn, metadata endpoint, engine *Engine, shutdown func()) {
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	input := scanner(connection)
	r, err := readRequest(input)
	if err != nil || subtle.ConstantTimeCompare([]byte(r.Auth), []byte(metadata.Secret)) != 1 {
		return
	}
	_ = connection.SetReadDeadline(time.Time{})
	if r.Action == "create" || r.Action == "attach" || r.Action == "ensure" {
		view, info, err := engine.Open(r)
		if err != nil {
			_ = sendReply(connection, Reply{Type: "error", Error: err.Error()})
			return
		}
		defer view.Close()
		if sendReply(connection, Reply{Type: "ready", Info: &info, Version: metadata.Version}) != nil {
			return
		}
		finished := make(chan struct{})
		go func() {
			defer close(finished)
			defer connection.Close()
			for {
				next, err := readRequest(input)
				if err != nil {
					return
				}
				if err := view.Apply(next); err != nil {
					view.engine.mu.Lock()
					view.offer(Reply{Type: "error", Error: err.Error()})
					view.engine.mu.Unlock()
				}
			}
		}()
		for {
			select {
			case <-finished:
				return
			case <-view.Done():
				return
			case reply := <-view.Frames():
				if sendReply(connection, reply) != nil || (reply.Type == "exit" || reply.Type == "error") {
					return
				}
			}
		}
	}
	reply := Reply{Type: "result", Version: metadata.Version}
	switch r.Action {
	case "ping":
	case "shutdown":
		err = engine.StopIdle()
	case "list":
		reply.Sessions = engine.List()
	case "history":
		reply.Lines, reply.ScreenOnly, err = engine.History(r.ID)
	case "terminate":
		err = engine.Terminate(r.ID)
	case "rename":
		var info Info
		info, err = engine.Rename(r.ID, r.Name)
		if err == nil {
			reply.Info = &info
		}
	default:
		err = fmt.Errorf("INVALID_SESSION_ACTION")
	}
	if err != nil {
		reply.Error = err.Error()
	}
	_ = sendReply(connection, reply)
	if r.Action == "shutdown" && err == nil {
		shutdown()
	}
}

func (e *Engine) Close() {
	e.mu.Lock()
	for _, s := range e.sessions {
		s.process.Kill()
	}
	e.mu.Unlock()
}

func (c *Client) connect(ctx context.Context, request Request) (net.Conn, *bufio.Scanner, error) {
	bytes, err := os.ReadFile(filepath.Join(c.Root, "endpoint.json"))
	if err != nil {
		return nil, nil, fmt.Errorf("SESSION_ENGINE_NOT_RUNNING")
	}
	var metadata endpoint
	if json.Unmarshal(bytes, &metadata) != nil || len(metadata.Secret) != 64 {
		return nil, nil, fmt.Errorf("SESSION_ENGINE_METADATA_INVALID")
	}
	if metadata.Protocol != Protocol {
		return nil, nil, fmt.Errorf("SESSION_PROTOCOL_UNSUPPORTED")
	}
	connection, err := dial(ctx, metadata.Address)
	if err != nil {
		return nil, nil, fmt.Errorf("SESSION_ENGINE_NOT_RUNNING")
	}
	request.Protocol = Protocol
	request.Auth = metadata.Secret
	_ = connection.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := json.NewEncoder(connection).Encode(request); err != nil {
		connection.Close()
		return nil, nil, err
	}
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	return connection, scanner(connection), nil
}

func (c *Client) Request(ctx context.Context, r Request) (Reply, error) {
	reply, err := c.request(ctx, r)
	if r.Action == "rename" && err != nil && err.Error() == "INVALID_SESSION_ACTION" {
		return c.renameLegacy(ctx, r)
	}
	if err == nil {
		err = c.applyNames(&reply)
	}
	return reply, err
}

func (c *Client) request(ctx context.Context, r Request) (Reply, error) {
	connection, input, err := c.connect(ctx, r)
	if err != nil {
		return Reply{}, err
	}
	defer connection.Close()
	return readReply(input)
}

func (c *Client) Ensure(ctx context.Context) error {
	c.startMu.Lock()
	defer c.startMu.Unlock()
	// Serialize upgrade/start across the network agent and local CLI processes.
	unlockStart, err := c.lockClient(ctx, "engine-start.lock")
	if err != nil {
		return err
	}
	defer unlockStart()
	if reply, err := c.request(ctx, Request{Action: "ping"}); err == nil {
		newer, valid := semver.CompareStrings(c.Version, reply.Version)
		if !valid || newer <= 0 {
			return nil
		}
		// StopIdle is atomic with Open: a busy engine always keeps its PTYs.
		if _, err := c.request(ctx, Request{Action: "shutdown"}); err != nil {
			if err.Error() == "SESSION_ENGINE_BUSY" {
				return nil
			}
			return err
		}
		// The engine removes its endpoint before releasing the lock. Do not let its
		// deferred cleanup remove a replacement engine's endpoint.
		for {
			unlock, err := lockEngine(c.Root)
			if err == nil {
				unlock()
				break
			}
			if err.Error() != "SESSION_ENGINE_ALREADY_RUNNING" {
				return err
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(10 * time.Millisecond):
			}
		}
	} else if err.Error() != "SESSION_ENGINE_NOT_RUNNING" {
		return err
	}
	if err := secureDirectory(c.Root); err != nil {
		return err
	}
	path, err := c.cachedExecutable()
	if err != nil {
		return err
	}
	command := exec.Command(path, "session", "serve", "--root", c.Root)
	command.Env = engineEnvironment(os.Environ())
	detach(command)
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("SESSION_ENGINE_START_TIMEOUT")
		case <-ticker.C:
			if _, err := c.Request(ctx, Request{Action: "ping"}); err == nil {
				return nil
			}
		}
	}
}

func engineEnvironment(environment []string) []string {
	result := make([]string, 0, len(environment))
	for _, value := range environment {
		name, _, _ := strings.Cut(value, "=")
		switch name {
		case "PDMUX_TOKEN", "PDMUX_SERVER", "PDMUX_CONFIG", "PDMUX_DESKTOP_AGENT", "PDMUX_RESTART", "TMUX":
			continue
		}
		result = append(result, value)
	}
	return result
}

func (c *Client) cachedExecutable() (string, error) {
	path := c.Executable
	if path == "" {
		path, _ = os.Executable()
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(bytes)
	directory := filepath.Join(c.Root, "engines", hex.EncodeToString(hash[:]))
	if err := secureDirectory(directory); err != nil {
		return "", err
	}
	name := filepath.Join(directory, "pdmux-agent"+executableSuffix())
	if existing, err := os.ReadFile(name); err == nil && sha256.Sum256(existing) == hash {
		return name, nil
	}
	file, err := os.CreateTemp(directory, ".engine-")
	if err != nil {
		return "", err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0o700); err != nil {
		file.Close()
		return "", err
	}
	if _, err := file.Write(bytes); err != nil {
		file.Close()
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	if err := secureFile(temporary); err != nil {
		return "", err
	}
	if err := os.Rename(temporary, name); err != nil {
		return "", err
	}
	return name, nil
}

type Attachment struct {
	Info       Info
	connection net.Conn
	mu         sync.Mutex
	replies    chan Reply
	done       chan struct{}
	once       sync.Once
}

func (c *Client) Attach(ctx context.Context, request Request) (*Attachment, error) {
	if err := c.Ensure(ctx); err != nil {
		return nil, err
	}
	return c.attachNamed(ctx, request)
}

func (c *Client) attach(ctx context.Context, request Request) (*Attachment, error) {
	connection, input, err := c.connect(ctx, request)
	if err != nil {
		return nil, err
	}
	ready, err := readReply(input)
	if err != nil {
		connection.Close()
		return nil, err
	}
	if ready.Protocol != Protocol || ready.Info == nil {
		connection.Close()
		return nil, fmt.Errorf("SESSION_PROTOCOL_UNSUPPORTED")
	}
	_ = connection.SetReadDeadline(time.Time{})
	a := &Attachment{Info: *ready.Info, connection: connection, replies: make(chan Reply, 1), done: make(chan struct{})}
	go func() {
		defer close(a.replies)
		defer a.Close()
		for {
			reply, err := readReply(input)
			if err != nil {
				if reply.Error == "" {
					reply = Reply{Type: "error", Error: "SESSION_CONNECTION_LOST"}
				}
				select {
				case a.replies <- reply:
				case <-a.done:
				}
				return
			}
			select {
			case a.replies <- reply:
			case <-a.done:
				return
			}
			if reply.Type == "exit" || reply.Type == "error" {
				return
			}
		}
	}()
	return a, nil
}

func (a *Attachment) Replies() <-chan Reply { return a.replies }
func (a *Attachment) Send(request Request) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	request.Protocol = Protocol
	_ = a.connection.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return json.NewEncoder(a.connection).Encode(request)
}
func (a *Attachment) Close() { a.once.Do(func() { close(a.done); _ = a.connection.Close() }) }
