package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// artifactPathPattern is the contract's own pattern, restated. See the two-layer
// note in refuse.go for why a second copy is the point rather than an oversight.
var artifactPathPattern = regexp.MustCompile(`^/[A-Za-z0-9._~-][A-Za-z0-9._~/-]*$`)

// downloadMode is the mode the artifact is written with while it is being
// hashed. It is NOT executable, and it is not group- or world-readable: between
// the first byte and the hash comparison the file is a blob of unverified bytes
// sitting next to the agent's own binary, and the one thing it must not be
// during that window is runnable.
const downloadMode os.FileMode = 0o600

// executableMode is applied to the fd AFTER the hash matches, and never by path.
const executableMode os.FileMode = 0o755

// Origin turns the agent's WebSocket endpoint back into the HTTP origin the
// artifact is fetched from.
//
// It is derived from the URL the agent is CONNECTED TO — the one in its own 0600
// config, the one it authenticated to — and never from anything in the frame.
func Origin(serverURL string) (string, error) {
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return "", fmt.Errorf("unusable server address %q: %w", serverURL, err)
	}
	switch parsed.Scheme {
	case "wss", "https":
		parsed.Scheme = "https"
	case "ws", "http":
		parsed.Scheme = "http"
	default:
		return "", fmt.Errorf("unsupported server scheme %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("server address has no host: %q", serverURL)
	}
	// Everything below the origin goes: the endpoint is /agent/ws, the artifact is
	// somewhere else entirely, and carrying the path over would produce
	// /agent/ws/releases/… on the first refactor that forgets to strip it.
	parsed.Path = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.User = nil
	return parsed.String(), nil
}

// ArtifactURL joins a server-supplied PATH onto the agent's own origin.
func ArtifactURL(serverURL, artifactPath string) (string, error) {
	if err := checkArtifactPath(artifactPath); err != nil {
		return "", err
	}
	origin, err := Origin(serverURL)
	if err != nil {
		return "", refuse(CodeBadArtifactPath, "%v", err)
	}
	return origin + artifactPath, nil
}

// fetch downloads the artifact into dest, hashing as it goes.
//
// THE HASH IS TAKEN ON THE FD THAT IS LATER fchmod'd AND renamed — the file is
// never re-opened by path between the check and the use. Re-opening would make
// the check a statement about a name rather than about the bytes we are going to
// execute, and the directory it lives in is one the agent itself writes to.
//
// Be honest about what SHA256 buys here: the same server declares the hash and
// serves the bytes, so it defends against a corrupted or swapped static object,
// a truncated transfer and a CDN serving yesterday's build. It is not a
// signature and does not pretend to be one.
func (e *Engine) fetch(ctx context.Context, update protocol.AgentUpdate, dest string, onProgress func(pct int)) error {
	target, err := ArtifactURL(e.opt.ServerURL, update.ArtifactPath)
	if err != nil {
		return err
	}
	if update.Bytes <= 0 {
		return refuse(CodeSizeMismatch, "the update does not say how many bytes to expect")
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return refuse(CodeDownloadFailed, "cannot build the artifact request: %v", err)
	}
	// The key rides in a header on a request that, by construction, can only go to
	// our own origin — the path check above and the redirect policy below are what
	// make that true, which is why the header is safe to attach here.
	request.Header.Set(protocol.AgentKeyHeader, e.opt.Token)

	client := &http.Client{CheckRedirect: sameOriginOnly}
	response, err := client.Do(request)
	if err != nil {
		return classifyTransport(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return refuse(CodeDownloadFailed, "the server answered %s for the artifact", response.Status)
	}

	file, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, downloadMode)
	if err != nil {
		return refuse(CodeExeNotWritable, "cannot stage the download at %s: %v", dest, err)
	}
	// Closed explicitly on the success path too; the deferred close is for every
	// return in between and is harmless afterwards.
	defer file.Close()
	// O_EXCL cannot state the mode when the umask has an opinion, so say it.
	if err := file.Chmod(downloadMode); err != nil {
		return refuse(CodeExeNotWritable, "cannot set the mode of the staged download: %v", err)
	}

	digest := sha256.New()
	// bytes+1 so a body that is LONGER than promised is detected rather than
	// silently truncated to the right length — a server serving a different (and
	// larger) artifact under the right size must not look like a hash mismatch.
	written, err := io.Copy(io.MultiWriter(file, digest), &progressReader{
		reader:   io.LimitReader(response.Body, update.Bytes+1),
		total:    update.Bytes,
		onUpdate: onProgress,
		clock:    e.opt.Now,
	})
	if err != nil {
		return classifyTransport(err)
	}
	if written != update.Bytes {
		return refuse(CodeSizeMismatch, "the artifact is %d bytes, the update promised %d", written, update.Bytes)
	}
	if sum := hex.EncodeToString(digest.Sum(nil)); !strings.EqualFold(sum, update.SHA256) {
		return refuse(CodeShaMismatch, "the artifact hashes to %s, the update promised %s", sum, update.SHA256)
	}

	// Executable ONLY now, and on the fd we hashed.
	if err := file.Chmod(executableMode); err != nil {
		return refuse(CodeExeNotWritable, "cannot make the staged download executable: %v", err)
	}
	// A close error is a write error that has not surfaced yet — on a full or
	// remote filesystem this is where it appears, and ignoring it would hand a
	// truncated binary to Gate 1.
	if err := file.Close(); err != nil {
		return refuse(CodeDownloadFailed, "cannot finish writing the staged download: %v", err)
	}
	return nil
}

// sameOriginOnly refuses to follow a redirect off our own origin.
//
// A redirect is how an absolute URL sneaks back in after the path check: the
// server hands out `/releases/x`, answers 302, and points at anywhere it likes —
// with the agent's key already attached to the request. Same-origin redirects are
// allowed (a reverse proxy adding a trailing slash is ordinary); anything else
// is the capability the path check exists to withhold.
func sameOriginOnly(request *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return refuse(CodeDownloadFailed, "the artifact redirected more than 5 times")
	}
	first := via[0].URL
	if request.URL.Scheme != first.Scheme || request.URL.Host != first.Host {
		return refuse(CodeRedirectRefused, "the artifact redirected to another origin: %s://%s",
			request.URL.Scheme, request.URL.Host)
	}
	return nil
}

// classifyTransport keeps a refusal that travelled out through http.Client
// wrapped in a *url.Error — the redirect policy's own error arrives that way,
// and reporting it as a generic download failure would lose the one code an
// operator needs to see. explain unwraps, so the nesting costs nothing here.
func classifyTransport(err error) error {
	if code, message := explain(err); code != CodeDownloadFailed {
		return refuse(code, "%s", message)
	}
	return refuse(CodeDownloadFailed, "%v", err)
}

// progressReader reports download progress without turning every 32KB read into
// a WebSocket frame: at most one report per progressInterval, plus one at the
// end. A 30MB artifact on a slow link is minutes of silence otherwise, and
// silence is indistinguishable from a hung agent.
type progressReader struct {
	reader   io.Reader
	total    int64
	read     int64
	onUpdate func(pct int)
	clock    func() time.Time
	last     time.Time
	lastPct  int
}

const progressInterval = 2 * time.Second

func (p *progressReader) Read(buffer []byte) (int, error) {
	n, err := p.reader.Read(buffer)
	p.read += int64(n)
	if p.onUpdate == nil || p.total <= 0 {
		return n, err
	}
	pct := int(p.read * 100 / p.total)
	if pct > 100 {
		pct = 100
	}
	now := p.clock()
	if pct != p.lastPct && (p.last.IsZero() || now.Sub(p.last) >= progressInterval) {
		p.last = now
		p.lastPct = pct
		p.onUpdate(pct)
	}
	return n, err
}
