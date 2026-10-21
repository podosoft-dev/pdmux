package session

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type namedTestProcess struct {
	pid    int
	output chan []byte
	exited chan *int
	once   sync.Once
}

func (p *namedTestProcess) Pid() *int               { return &p.pid }
func (p *namedTestProcess) Write(data string) error { p.output <- []byte(data); return nil }
func (p *namedTestProcess) Resize(int, int) error   { return nil }
func (p *namedTestProcess) Output() <-chan []byte   { return p.output }
func (p *namedTestProcess) Exit() <-chan *int       { return p.exited }
func (p *namedTestProcess) Kill() {
	p.once.Do(func() { code := 0; p.exited <- &code; close(p.output) })
}

type prefixedConnection struct {
	net.Conn
	input io.Reader
}

func (c prefixedConnection) Read(p []byte) (int, error) { return c.input.Read(p) }

func legacyNamesFixture(t *testing.T) (*Client, *Engine) {
	t.Helper()
	root := t.TempDir()
	if err := secureDirectory(root); err != nil {
		t.Fatal(err)
	}
	listener, address, err := listen(root)
	if err != nil {
		t.Fatal(err)
	}
	metadata := endpoint{Protocol: Protocol, Address: address, Secret: strings.Repeat("a", 64), Version: "0.1.32"}
	encoded, _ := json.Marshal(metadata)
	if err := os.WriteFile(filepath.Join(root, "endpoint.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	var created atomic.Int32
	engine := NewEngine(func(int, int, string) (Process, error) {
		return &namedTestProcess{pid: int(created.Add(1)) + 100, output: make(chan []byte, 32), exited: make(chan *int, 1)}, nil
	})
	var workers sync.WaitGroup
	workers.Go(func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			workers.Go(func() {
				input := bufio.NewReader(connection)
				first, err := input.ReadBytes('\n')
				if err != nil {
					connection.Close()
					return
				}
				var request Request
				if json.Unmarshal(first, &request) == nil && request.Auth == metadata.Secret && request.Action == "rename" {
					defer connection.Close()
					_ = sendReply(connection, Reply{Type: "error", Error: "INVALID_SESSION_ACTION"})
					return
				}
				serveConnection(prefixedConnection{connection, io.MultiReader(bytes.NewReader(first), input)}, metadata, engine, func() { _ = listener.Close() })
			})
		}
	})
	t.Cleanup(func() { _ = listener.Close(); engine.Close(); workers.Wait() })
	return &Client{Root: root, Version: "0.1.32"}, engine
}

// The native CI matrix selects TestNative* on all three operating systems.
func TestNativeLegacyNames(t *testing.T) {
	t.Run("[TC-PDUI-237] old engines rename without replacing programs and retain names across clients", func(t *testing.T) {
		client, engine := legacyNamesFixture(t)
		ctx := context.Background()
		viewer, err := client.Attach(ctx, Request{Action: "create", Name: "main", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer viewer.Close()
		original := viewer.Info
		renamed, err := client.Request(ctx, Request{Action: "rename", ID: original.ID, Name: "work"})
		if err != nil || renamed.Info == nil || renamed.Info.Name != "work" || *renamed.Info.PID != *original.PID {
			t.Fatalf("rename: %+v %v", renamed, err)
		}
		if engine.List()[0].Name != "main" {
			t.Fatal("test did not keep the legacy helper unchanged")
		}
		replacement := &Client{Root: client.Root, Version: "0.1.33"}
		if err := replacement.Ensure(ctx); err != nil {
			t.Fatal(err)
		}
		list, err := replacement.Request(ctx, Request{Action: "list"})
		if err != nil || len(list.Sessions) != 1 || list.Sessions[0].Name != "work" || list.Sessions[0].ID != original.ID || *list.Sessions[0].PID != *original.PID {
			t.Fatalf("replacement: %+v %v", list, err)
		}
		attached, err := replacement.Attach(ctx, Request{Action: "attach", Name: "work", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer attached.Close()
		if attached.Info.ID != original.ID || attached.Info.Name != "work" {
			t.Fatal("name resolved to a different program")
		}
		if _, err := replacement.Attach(ctx, Request{Action: "attach", Name: "main", Cols: 80, Rows: 24}); err == nil || err.Error() != "SESSION_NOT_FOUND" {
			t.Fatalf("old name still attaches: %v", err)
		}
		fresh, err := replacement.Attach(ctx, Request{Action: "create", Name: "main", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer fresh.Close()
		if fresh.Info.ID == original.ID || fresh.Info.Name != "main" {
			t.Fatal("reusing the old name reattached its renamed program")
		}
		for _, id := range []string{fresh.Info.ID, original.ID} {
			if _, err := replacement.Request(ctx, Request{Action: "terminate", ID: id}); err != nil {
				t.Fatal(err)
			}
		}
	})
	t.Run("[TC-PDUI-237] duplicate renames are serialized across clients and invalid targets remain errors", func(t *testing.T) {
		client, _ := legacyNamesFixture(t)
		ctx := context.Background()
		first, err := client.Attach(ctx, Request{Action: "create", Name: "one", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer first.Close()
		second, err := client.Attach(ctx, Request{Action: "create", Name: "two", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer second.Close()
		results := make(chan error, 2)
		for _, id := range []string{first.Info.ID, second.Info.ID} {
			go func() {
				other := &Client{Root: client.Root}
				_, err := other.Request(ctx, Request{Action: "rename", ID: id, Name: "same"})
				results <- err
			}()
		}
		success, duplicates := 0, 0
		for range 2 {
			err := <-results
			if err == nil {
				success++
			} else if err.Error() == "SESSION_EXISTS" {
				duplicates++
			} else {
				t.Fatal(err)
			}
		}
		if success != 1 || duplicates != 1 {
			t.Fatal("duplicate names accepted")
		}
		for _, request := range []Request{{Action: "rename", ID: "missing", Name: "new"}, {Action: "rename", ID: first.Info.ID, Name: "bad name"}} {
			if _, err := client.Request(ctx, request); err == nil {
				t.Fatal("invalid rename accepted")
			}
		}
	})
	t.Run("[TC-PDUI-237] names are private and scoped to the engine generation", func(t *testing.T) {
		client, engine := legacyNamesFixture(t)
		ctx := context.Background()
		viewer, err := client.Attach(ctx, Request{Action: "create", Name: "one", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer viewer.Close()
		if _, err := client.Request(ctx, Request{Action: "rename", ID: viewer.Info.ID, Name: "renamed"}); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(client.Root, "session-names.json")
		if runtime.GOOS != "windows" {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0o600 {
				t.Fatal("name catalog is not private")
			}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var catalog sessionNames
		if err := json.Unmarshal(data, &catalog); err != nil {
			t.Fatal(err)
		}
		if catalog.Generation == strings.Repeat("a", 64) {
			t.Fatal("copied endpoint credential into name catalog")
		}
		catalog.Generation = "previous-engine"
		encoded, _ := json.Marshal(catalog)
		if err := os.WriteFile(path, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
		list, err := client.Request(ctx, Request{Action: "list"})
		if err != nil || list.Sessions[0].Name != engine.List()[0].Name {
			t.Fatalf("stale name applied: %v", err)
		}
	})
}

func TestNativeIdleEngineUpgrade(t *testing.T) {
	t.Run("[TC-PDTERM-026] idle old engines stop before replacement while current and newer engines remain", func(t *testing.T) {
		for _, version := range []string{"0.1.32", "0.1.33", "0.1.34"} {
			t.Run(version, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				root := t.TempDir()
				finished := make(chan error, 1)
				go func() {
					finished <- Serve(ctx, root, version, func(int, int, string) (Process, error) { return nil, fmt.Errorf("unexpected spawn") })
				}()
				client := &Client{Root: root, Version: "0.1.33", Executable: filepath.Join(root, "missing-new-binary")}
				deadline := time.Now().Add(2 * time.Second)
				for {
					if _, err := client.Request(ctx, Request{Action: "ping"}); err == nil {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("engine unavailable")
					}
					time.Sleep(time.Millisecond)
				}
				err := client.Ensure(ctx)
				if version == "0.1.32" {
					if err == nil {
						t.Fatal("old helper silently retained")
					}
					if _, err := client.Request(ctx, Request{Action: "ping"}); err == nil {
						t.Fatal("old helper still running")
					}
				} else if err != nil {
					t.Fatal(err)
				}
				cancel()
				select {
				case err := <-finished:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(time.Second):
					t.Fatal("helper did not stop")
				}
			})
		}
	})
}
