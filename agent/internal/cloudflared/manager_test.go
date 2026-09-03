package cloudflared

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func response(request *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
		Request:    request,
	}
}

func testBinary(version string) []byte {
	return []byte("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"cloudflared version " + version + "\"; exit 0; fi\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n")
}

func tokenCheckingBinary(version string) []byte {
	return []byte("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"cloudflared version " + version + "\"; exit 0; fi\nif [ \"$#\" -ne 5 ] || [ \"$3\" != \"--pidfile\" ] || [ \"$TUNNEL_TOKEN\" != \"secret-tunnel-token\" ]; then exit 42; fi\nsleep 0.2\nprintf '%s' \"$$\" > \"$4\"\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n")
}

func failingBinary(version string) []byte {
	return []byte("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"cloudflared version " + version + "\"; exit 0; fi\nexit 1\n")
}

func TestVerifiedInstallAndCache(t *testing.T) {
	t.Run("[TC-PDAGENT-128] installs only the official asset with its GitHub digest and reuses the daily cache", func(t *testing.T) {
		binary := testBinary("2026.8.0")
		sum := sha256.Sum256(binary)
		asset := releaseAsset{
			Name:               "cloudflared-linux-amd64",
			BrowserDownloadURL: "https://github.com/cloudflare/cloudflared/releases/download/2026.8.0/cloudflared-linux-amd64",
			Digest:             "sha256:" + hex.EncodeToString(sum[:]),
			Size:               int64(len(binary)),
		}
		metadata, err := json.Marshal(releaseResponse{TagName: "2026.8.0", Assets: []releaseAsset{asset}})
		if err != nil {
			t.Fatal(err)
		}
		var requests atomic.Int32
		client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			requests.Add(1)
			if request.URL.String() == releasesURL {
				return response(request, http.StatusOK, string(metadata)), nil
			}
			return response(request, http.StatusOK, string(binary)), nil
		})}
		manager := New(Options{Dir: t.TempDir(), HTTPClient: client, GOOS: "linux", GOARCH: "amd64"})
		if err := state.EnsureDir(manager.dir); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(manager.binaryPath(), testBinary("2026.7.0"), 0o700); err != nil {
			t.Fatal(err)
		}
		version, err := manager.ensureBinary(context.Background(), 24*time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		if version != "2026.8.0" {
			t.Fatalf("version = %q", version)
		}
		if previous, err := binaryVersion(context.Background(), manager.binaryPath()+".previous"); err != nil || previous != "2026.7.0" {
			t.Fatalf("previous = %q, error = %v", previous, err)
		}
		if _, err := manager.ensureBinary(context.Background(), 24*time.Hour); err != nil {
			t.Fatal(err)
		}
		if requests.Load() != 2 {
			t.Fatalf("requests = %d, want metadata + artifact once", requests.Load())
		}
	})

	t.Run("[TC-PDAGENT-128] rejects bytes that do not match the release digest", func(t *testing.T) {
		manager := New(Options{Dir: t.TempDir(), GOOS: "linux", GOARCH: "amd64"})
		release := cachedRelease{
			Version: "2026.8.0",
			Asset: releaseAsset{
				Name:               "cloudflared-linux-amd64",
				BrowserDownloadURL: "https://github.com/cloudflare/cloudflared/releases/download/x/cloudflared-linux-amd64",
				Digest:             "sha256:" + strings.Repeat("0", 64),
				Size:               3,
			},
		}
		manager.httpClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return response(request, http.StatusOK, "bad"), nil
		})}
		if err := manager.install(context.Background(), release); err == nil || !strings.Contains(err.Error(), "digest") {
			t.Fatalf("install error = %v", err)
		}
	})
}

func TestManagedProcess(t *testing.T) {
	t.Run("[TC-PDAGENT-129] starts from agent state, reports status, and stops when disabled", func(t *testing.T) {
		dir := t.TempDir()
		manager := New(Options{Dir: dir, GOOS: "linux", GOARCH: "amd64"})
		if err := state.EnsureDir(manager.dir); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(manager.binaryPath(), tokenCheckingBinary("2026.8.0"), 0o700); err != nil {
			t.Fatal(err)
		}
		cache := cachedRelease{
			CheckedAt: time.Now().UTC(),
			Version:   "2026.8.0",
			Asset:     releaseAsset{Name: "cloudflared-linux-amd64"},
		}
		body, _ := json.Marshal(cache)
		if err := state.WriteFilePrivate(filepath.Join(manager.dir, "release.json"), body); err != nil {
			t.Fatal(err)
		}
		oldPoll := readyPoll
		readyPoll = 10 * time.Millisecond
		defer func() { readyPoll = oldPoll }()

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		manager.Apply(ctx, protocol.AgentCloudflaredConfig{Enabled: true, Token: "secret-tunnel-token", CheckIntervalSec: 86400})
		deadline := time.Now().Add(time.Second)
		for manager.Status().State != protocol.CloudflaredConnecting && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if manager.Status().State != protocol.CloudflaredConnecting {
			t.Fatalf("status before pidfile = %+v", manager.Status())
		}
		for manager.Status().State != protocol.CloudflaredConnected && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if got := manager.Status(); got.State != protocol.CloudflaredConnected || got.Version == nil || *got.Version != "2026.8.0" {
			t.Fatalf("status = %+v", got)
		}
		manager.Apply(ctx, protocol.AgentCloudflaredConfig{Enabled: false, CheckIntervalSec: 86400})
		deadline = time.Now().Add(time.Second)
		for manager.Status().State != protocol.CloudflaredOff && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if manager.Status().State != protocol.CloudflaredOff {
			t.Fatalf("status = %+v", manager.Status())
		}
	})

	t.Run("[TC-PDAGENT-128] restores the previous binary when the candidate exits before connecting", func(t *testing.T) {
		dir := t.TempDir()
		manager := New(Options{Dir: dir, GOOS: "linux", GOARCH: "amd64"})
		if err := state.EnsureDir(manager.dir); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(manager.binaryPath(), failingBinary("2026.8.0"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(manager.binaryPath()+".previous", tokenCheckingBinary("2026.7.0"), 0o700); err != nil {
			t.Fatal(err)
		}
		cache := cachedRelease{
			CheckedAt: time.Now().UTC(),
			Version:   "2026.8.0",
			Asset:     releaseAsset{Name: "cloudflared-linux-amd64"},
		}
		body, _ := json.Marshal(cache)
		if err := state.WriteFilePrivate(filepath.Join(manager.dir, "release.json"), body); err != nil {
			t.Fatal(err)
		}
		oldPoll := readyPoll
		readyPoll = 10 * time.Millisecond
		defer func() { readyPoll = oldPoll }()

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		manager.Apply(ctx, protocol.AgentCloudflaredConfig{Enabled: true, Token: "secret-tunnel-token", CheckIntervalSec: 86400})
		deadline := time.Now().Add(2 * time.Second)
		for manager.Status().State != protocol.CloudflaredConnected && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if got := manager.Status(); got.State != protocol.CloudflaredConnected || got.Version == nil || *got.Version != "2026.7.0" {
			t.Fatalf("status after rollback = %+v", got)
		}
		manager.Apply(ctx, protocol.AgentCloudflaredConfig{Enabled: false, CheckIntervalSec: 86400})
		manager.Close()
		if version, err := binaryVersion(context.Background(), manager.binaryPath()); err != nil || version != "2026.7.0" {
			t.Fatalf("restored version = %q, error = %v", version, err)
		}
	})
}
