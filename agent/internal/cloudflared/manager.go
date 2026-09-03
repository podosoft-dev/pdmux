// Package cloudflared installs and runs the Cloudflare connector requested by
// server configuration. It never changes system packages or service units: the
// verified binary and its rollback copy live under the agent's private state dir.
package cloudflared

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
)

const (
	releasesURL         = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
	maxArtifact         = 100 * 1024 * 1024
	defaultReadyPoll    = 200 * time.Millisecond
	defaultReadyTimeout = 60 * time.Second
)

var readyPoll = defaultReadyPoll
var readyTimeout = defaultReadyTimeout

type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Digest             string `json:"digest"`
	Size               int64  `json:"size"`
}

type releaseResponse struct {
	TagName string         `json:"tag_name"`
	Assets  []releaseAsset `json:"assets"`
}

type cachedRelease struct {
	CheckedAt time.Time    `json:"checkedAt"`
	Version   string       `json:"version"`
	Asset     releaseAsset `json:"asset"`
}

type Options struct {
	Dir        string
	Logger     *log.Logger
	HTTPClient *http.Client
	GOOS       string
	GOARCH     string
}

// Manager serialises configuration changes and exposes a secret-free heartbeat view.
type Manager struct {
	dir        string
	logger     *log.Logger
	httpClient *http.Client
	goos       string
	goarch     string

	mu          sync.Mutex
	status      protocol.CloudflaredStatus
	cancel      context.CancelFunc
	key         string
	reconcileMu sync.Mutex
	workers     sync.WaitGroup
}

func New(options Options) *Manager {
	logger := options.Logger
	if logger == nil {
		logger = log.Silent()
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	goos := options.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	goarch := options.GOARCH
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	status := protocol.NewCloudflaredStatus()
	return &Manager{dir: filepath.Join(options.Dir, "cloudflared"), logger: logger, httpClient: client, goos: goos, goarch: goarch, status: status}
}

// Apply reconciles asynchronously so a config frame never blocks the socket read loop.
func (m *Manager) Apply(parent context.Context, config protocol.AgentCloudflaredConfig) {
	m.logger.AddSecret(config.Token)
	key := fmt.Sprintf("%t:%x:%d", config.Enabled, sha256.Sum256([]byte(config.Token)), config.CheckIntervalSec)
	m.mu.Lock()
	if key == m.key {
		m.mu.Unlock()
		return
	}
	if m.cancel != nil {
		m.cancel()
	}
	ctx, cancel := context.WithCancel(parent)
	m.cancel = cancel
	m.key = key
	m.workers.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.workers.Done()
		m.reconcile(ctx, config)
	}()
}

func (m *Manager) Status() protocol.CloudflaredStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *Manager) Close() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	m.mu.Unlock()
	m.workers.Wait()
}

func (m *Manager) reconcile(ctx context.Context, config protocol.AgentCloudflaredConfig) {
	// Apply may be called again while the previous process is still observing its
	// cancellation. Serialising the complete reconcile prevents two generations
	// from swapping or executing the same state-directory binary concurrently.
	m.reconcileMu.Lock()
	defer m.reconcileMu.Unlock()
	if !config.Enabled || config.Token == "" {
		m.set(protocol.CloudflaredOff, nil, nil)
		return
	}
	interval := time.Duration(config.CheckIntervalSec) * time.Second
	for ctx.Err() == nil {
		m.set(protocol.CloudflaredInstalling, nil, nil)
		version, err := m.ensureBinary(ctx, interval)
		if err != nil {
			m.fail("CLOUDFLARED_INSTALL_FAILED", err)
			return
		}
		outcome, runErr := m.run(ctx, config.Token, version, interval)
		if outcome == "refresh" {
			continue
		}
		if outcome == "stopped" {
			return
		}
		// A candidate that cannot stay alive never replaces the last-good binary.
		// Restore once and run it without re-reading the latest cache, which would
		// otherwise install the same broken candidate again immediately.
		if m.restorePrevious() {
			previousVersion, versionErr := binaryVersion(ctx, m.binaryPath())
			if versionErr == nil {
				m.logger.Warn("Rolled back Cloudflare connector", log.F("failedVersion", version))
				outcome, runErr = m.run(ctx, config.Token, previousVersion, interval)
				if outcome == "refresh" {
					continue
				}
				if outcome == "stopped" {
					return
				}
			}
		}
		m.fail("CLOUDFLARED_EXITED", runErr)
		return
	}
}

func (m *Manager) run(ctx context.Context, token, version string, refreshAfter time.Duration) (string, error) {
	processContext, stop := context.WithCancel(ctx)
	defer stop()
	m.set(protocol.CloudflaredConnecting, &version, nil)
	pidPath := filepath.Join(m.dir, "cloudflared.pid")
	_ = os.Remove(pidPath)
	defer os.Remove(pidPath)
	command := exec.CommandContext(
		processContext,
		m.binaryPath(),
		"tunnel",
		"--no-autoupdate",
		"--pidfile",
		pidPath,
		"run",
	)
	command.Env = append(os.Environ(), "TUNNEL_TOKEN="+token)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return "failed", err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	poll := time.NewTicker(readyPoll)
	defer poll.Stop()
	deadline := time.NewTimer(readyTimeout)
	defer deadline.Stop()
ready:
	for {
		select {
		case err := <-done:
			return "failed", err
		case <-poll.C:
			if info, err := os.Stat(pidPath); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
				m.set(protocol.CloudflaredConnected, &version, nil)
				break ready
			}
		case <-deadline.C:
			stop()
			<-done
			return "failed", errors.New("cloudflared did not establish an edge connection before the deadline")
		case <-ctx.Done():
			<-done
			return "stopped", nil
		}
	}
	refresh := time.NewTimer(refreshAfter)
	defer refresh.Stop()
	select {
	case err := <-done:
		return "failed", err
	case <-ctx.Done():
		stop()
		<-done
		return "stopped", nil
	case <-refresh.C:
		stop()
		<-done
		return "refresh", nil
	}
}

func (m *Manager) ensureBinary(ctx context.Context, interval time.Duration) (string, error) {
	if interval < time.Hour {
		interval = 24 * time.Hour
	}
	release, err := m.release(ctx, interval)
	if err != nil {
		// A verified last-good binary keeps a working tunnel alive when GitHub is
		// temporarily unavailable. A first install still fails closed.
		if version, versionErr := binaryVersion(ctx, m.binaryPath()); versionErr == nil {
			return version, nil
		}
		return "", err
	}
	if version, versionErr := binaryVersion(ctx, m.binaryPath()); versionErr == nil && version == release.Version {
		return version, nil
	}
	if err := m.install(ctx, release); err != nil {
		if version, versionErr := binaryVersion(ctx, m.binaryPath()); versionErr == nil {
			return version, nil
		}
		return "", err
	}
	return binaryVersion(ctx, m.binaryPath())
}

func (m *Manager) release(ctx context.Context, interval time.Duration) (cachedRelease, error) {
	cachePath := filepath.Join(m.dir, "release.json")
	var cached cachedRelease
	if body, err := os.ReadFile(cachePath); err == nil && json.Unmarshal(body, &cached) == nil && time.Since(cached.CheckedAt) < interval {
		return cached, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, releasesURL, nil)
	if err != nil {
		return cachedRelease{}, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "pdmux-agent")
	response, err := m.httpClient.Do(request)
	if err != nil {
		return cachedRelease{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return cachedRelease{}, fmt.Errorf("release metadata returned HTTP %d", response.StatusCode)
	}
	var release releaseResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024)).Decode(&release); err != nil {
		return cachedRelease{}, err
	}
	name := assetName(m.goos, m.goarch)
	for _, asset := range release.Assets {
		if asset.Name != name {
			continue
		}
		if asset.Size <= 0 || asset.Size > maxArtifact || !strings.HasPrefix(asset.Digest, "sha256:") {
			return cachedRelease{}, errors.New("release asset has no trusted digest or valid size")
		}
		if !allowedURL(asset.BrowserDownloadURL) {
			return cachedRelease{}, errors.New("release asset URL is not on an allowed GitHub host")
		}
		cached = cachedRelease{CheckedAt: time.Now().UTC(), Version: strings.TrimPrefix(release.TagName, "v"), Asset: asset}
		body, marshalErr := json.Marshal(cached)
		if marshalErr == nil {
			_ = state.WriteFilePrivate(cachePath, body)
		}
		return cached, nil
	}
	return cachedRelease{}, fmt.Errorf("release has no asset for %s/%s", m.goos, m.goarch)
}

func (m *Manager) install(ctx context.Context, release cachedRelease) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, release.Asset.BrowserDownloadURL, nil)
	if err != nil {
		return err
	}
	response, err := m.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !allowedURL(response.Request.URL.String()) {
		return fmt.Errorf("artifact download was refused")
	}
	limited := io.LimitReader(response.Body, maxArtifact+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return err
	}
	if int64(len(body)) != release.Asset.Size {
		return fmt.Errorf("artifact size mismatch")
	}
	want := strings.TrimPrefix(release.Asset.Digest, "sha256:")
	sum := sha256.Sum256(body)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), want) {
		return fmt.Errorf("artifact digest mismatch")
	}
	binary := body
	if strings.HasSuffix(release.Asset.Name, ".tgz") {
		binary, err = untarBinary(body)
		if err != nil {
			return err
		}
	}
	if err := state.EnsureDir(m.dir); err != nil {
		return err
	}
	candidate := m.binaryPath() + ".candidate"
	if err := os.WriteFile(candidate, binary, 0o700); err != nil {
		return err
	}
	defer os.Remove(candidate)
	if err := os.Chmod(candidate, 0o700); err != nil {
		return err
	}
	if _, err := binaryVersion(ctx, candidate); err != nil {
		return fmt.Errorf("candidate validation failed: %w", err)
	}
	previous := m.binaryPath() + ".previous"
	_ = os.Remove(previous)
	if _, err := os.Stat(m.binaryPath()); err == nil {
		if err := os.Rename(m.binaryPath(), previous); err != nil {
			return err
		}
	}
	if err := os.Rename(candidate, m.binaryPath()); err != nil {
		_ = os.Rename(previous, m.binaryPath())
		return err
	}
	return nil
}

func (m *Manager) binaryPath() string { return filepath.Join(m.dir, "cloudflared") }

func (m *Manager) restorePrevious() bool {
	previous := m.binaryPath() + ".previous"
	if _, err := os.Stat(previous); err != nil {
		return false
	}
	failed := m.binaryPath() + ".failed"
	_ = os.Remove(failed)
	if err := os.Rename(m.binaryPath(), failed); err != nil {
		return false
	}
	if err := os.Rename(previous, m.binaryPath()); err != nil {
		_ = os.Rename(failed, m.binaryPath())
		return false
	}
	return true
}

func (m *Manager) set(stateValue protocol.CloudflaredState, version *string, code *string) {
	m.mu.Lock()
	m.status = protocol.CloudflaredStatus{State: stateValue, Version: version, ErrorCode: code}
	m.mu.Unlock()
}

func (m *Manager) fail(code string, err error) {
	m.set(protocol.CloudflaredFailed, nil, &code)
	m.logger.Warn("Cloudflare connector failed", log.F("code", code), log.F("error", err))
}

func binaryVersion(ctx context.Context, path string) (string, error) {
	output, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return "", err
	}
	fields := strings.Fields(string(output))
	for index, field := range fields {
		if field == "version" && index+1 < len(fields) {
			return strings.TrimSpace(fields[index+1]), nil
		}
	}
	return "", errors.New("cloudflared version output was not recognised")
}

func assetName(goos, goarch string) string {
	if goos == "darwin" {
		return fmt.Sprintf("cloudflared-darwin-%s.tgz", goarch)
	}
	return fmt.Sprintf("cloudflared-%s-%s", goos, goarch)
}

func allowedURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" {
		return false
	}
	return parsed.Hostname() == "github.com" || strings.HasSuffix(parsed.Hostname(), ".githubusercontent.com")
}

func untarBinary(body []byte) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	tarReader := tar.NewReader(reader)
	for {
		header, nextErr := tarReader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return nil, nextErr
		}
		if header.Typeflag == tar.TypeReg && filepath.Base(header.Name) == "cloudflared" {
			return io.ReadAll(io.LimitReader(tarReader, maxArtifact+1))
		}
	}
	return nil, errors.New("archive has no cloudflared binary")
}
