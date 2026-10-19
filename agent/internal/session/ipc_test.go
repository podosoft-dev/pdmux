package session

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestEngineIPCIsolation(t *testing.T) {
	t.Run("[TC-PDTERM-026] unauthenticated local requests cannot create or terminate programs", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		root := t.TempDir()
		finished := make(chan error, 1)
		go func() {
			finished <- Serve(ctx, root, "test", func(int, int, string) (Process, error) {
				t.Error("unauthenticated spawn")
				return nil, context.Canceled
			})
		}()
		client := &Client{Root: root}
		deadline := time.Now().Add(time.Second)
		for {
			if _, err := client.Request(ctx, Request{Action: "ping"}); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("engine unavailable")
			}
			time.Sleep(time.Millisecond)
		}
		data, err := os.ReadFile(filepath.Join(root, "endpoint.json"))
		if err != nil {
			t.Fatal(err)
		}
		var metadata endpoint
		if err := json.Unmarshal(data, &metadata); err != nil {
			t.Fatal(err)
		}
		connection, err := dial(ctx, metadata.Address)
		if err != nil {
			t.Fatal(err)
		}
		_ = connection.SetDeadline(time.Now().Add(time.Second))
		if err := json.NewEncoder(connection).Encode(Request{Protocol: Protocol, Auth: strings.Repeat("0", 64), Action: "create", Name: "unauthorized"}); err != nil {
			t.Fatal(err)
		}
		if _, err := readReply(scanner(connection)); err == nil {
			t.Fatal("unauthenticated IPC request accepted")
		}
		connection.Close()
		reply, err := client.Request(ctx, Request{Action: "list"})
		if err != nil || len(reply.Sessions) != 0 {
			t.Fatalf("unauthenticated request changed state: %v", err)
		}
		if runtime.GOOS != "windows" {
			for path, mode := range map[string]os.FileMode{root: 0o700, filepath.Join(root, "endpoint.json"): 0o600, metadata.Address: 0o600} {
				info, err := os.Stat(path)
				if err != nil || info.Mode().Perm() != mode {
					t.Fatalf("IPC path is not private: %s", path)
				}
			}
		}
		cancel()
		select {
		case err := <-finished:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("engine did not stop")
		}
	})
	t.Run("[TC-PDTERM-026] helper startup excludes network credentials and parent lifetime state", func(t *testing.T) {
		got := engineEnvironment([]string{"PATH=/bin", "HOME=/home/test", "PDMUX_TOKEN=secret", "PDMUX_CONFIG=private", "PDMUX_SERVER=https://invalid.example", "PDMUX_DESKTOP_AGENT=1", "PDMUX_RESTART=service", "TMUX=existing"})
		if strings.Join(got, "|") != "PATH=/bin|HOME=/home/test" {
			t.Fatal("helper inherited network credentials or supervision state")
		}
	})
}
