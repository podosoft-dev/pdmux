package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
)

const (
	// A real code shape: the `pdmxe_` prefix and four Crockford base32 groups.
	enrollCode = "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW"
	// Long enough that the logger's redaction applies (it skips secrets under six
	// runes so short words are not blanked out of ordinary messages).
	enrolledToken  = "pdmux_enrolled-token-value"
	enrolledHostID = "33333333-4444-4555-8666-777777777777"
)

type recordedRequest struct {
	method string
	path   string
	header http.Header
	body   []byte
}

// enrollStub is a real HTTP endpoint. A hand-written transport would be free to
// agree with the client about the two things most worth pinning here — that the
// code rides in the BODY (a custom header would never survive the web tier's
// allowlist) and that the body carries exactly the fields the API's DTO declares.
type enrollStub struct {
	mu       sync.Mutex
	requests []recordedRequest
	server   *httptest.Server
	url      string
}

// newEnrollStub answers with respond(n), n being the 0-based attempt number so a
// spec can fail twice and then succeed.
func newEnrollStub(t *testing.T, respond func(attempt int, w http.ResponseWriter)) *enrollStub {
	t.Helper()
	stub := &enrollStub{}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		stub.mu.Lock()
		attempt := len(stub.requests)
		stub.requests = append(stub.requests, recordedRequest{
			method: r.Method, path: r.URL.Path, header: r.Header.Clone(), body: body,
		})
		stub.mu.Unlock()
		respond(attempt, w)
	}))
	t.Cleanup(stub.server.Close)
	stub.url = stub.server.URL
	return stub
}

func (s *enrollStub) seen() []recordedRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]recordedRequest(nil), s.requests...)
}

func (s *enrollStub) count() int { return len(s.seen()) }

// succeed writes the 200 body the API returns from a redemption.
func succeed(w http.ResponseWriter) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"hostId":    enrolledHostID,
		"hostLabel": "workshop-mini",
		"token":     enrolledToken,
		"tokenId":   "44444444-5555-4666-8777-888888888888",
		"tokenName": "installer 2026-07-26T09:14Z",
	})
}

// refuse writes the API's error envelope (apps/api/src/common/all-exceptions.filter.ts).
func refuse(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": false,
		"error": map[string]any{
			"code": code, "message": message, "statusCode": status,
			"path": EnrollPath, "timestamp": "2026-07-26T09:14:00.000Z",
		},
	})
}

// enrollInput points an exchange at a stub and records the waits instead of
// taking them, so the retry SCHEDULE is asserted without a 17-second test.
func enrollInput(stub *enrollStub, sleeps *[]time.Duration) EnrollInput {
	return EnrollInput{
		Server:   stub.url,
		Code:     enrollCode,
		Hostname: "workshop-mini",
		OS:       "linux",
		Arch:     "arm64",
		Version:  "9.9.9",
		Sleep:    func(d time.Duration) { *sleeps = append(*sleeps, d) },
	}
}

func enrollOrFail(t *testing.T, in EnrollInput) EnrollResult {
	t.Helper()
	result, err := Enroll(context.Background(), in)
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	return result
}

func refusalOrFail(t *testing.T, in EnrollInput) *EnrollError {
	t.Helper()
	result, err := Enroll(context.Background(), in)
	if err == nil {
		t.Fatalf("Enroll succeeded with %+v, want a refusal", result)
	}
	var refusal *EnrollError
	if !errors.As(err, &refusal) {
		t.Fatalf("Enroll returned %T (%v), want *EnrollError", err, err)
	}
	return refusal
}

// newRecordingLogger collects the lines a command would have written, so a spec
// can read every one of them back and assert what is not in them.
func newRecordingLogger(into *[]string) *log.Logger {
	return log.New(log.Options{
		Level: log.LevelDebug,
		Sink:  func(line string) { *into = append(*into, line) },
	})
}

func TestEnrollRequestShape(t *testing.T) {
	t.Run("[TC-PDAGENT-071] sends the code in the body, never in a header", func(t *testing.T) {
		stub := newEnrollStub(t, func(_ int, w http.ResponseWriter) { succeed(w) })
		var sleeps []time.Duration
		result := enrollOrFail(t, enrollInput(stub, &sleeps))
		if result.Token != enrolledToken || result.HostID != enrolledHostID {
			t.Fatalf("result = %+v", result)
		}

		seen := stub.seen()
		if len(seen) != 1 {
			t.Fatalf("made %d requests, want 1", len(seen))
		}
		if seen[0].method != http.MethodPost || seen[0].path != EnrollPath {
			t.Fatalf("%s %s, want POST %s", seen[0].method, seen[0].path, EnrollPath)
		}
		if got := seen[0].header.Get("content-type"); !strings.Contains(got, "application/json") {
			t.Fatalf("content-type = %q", got)
		}
		// The web tier forwards a fixed header allowlist, so a code in a header
		// would simply never arrive. Nothing may put it there.
		for name, values := range seen[0].header {
			for _, value := range values {
				if strings.Contains(value, enrollCode) {
					t.Fatalf("header %s carries the enrollment code: %q", name, value)
				}
			}
		}
		if !strings.Contains(string(seen[0].body), enrollCode) {
			t.Fatalf("body does not carry the code: %s", seen[0].body)
		}
	})

	t.Run("[TC-PDAGENT-071] sends exactly the five fields the DTO declares", func(t *testing.T) {
		stub := newEnrollStub(t, func(_ int, w http.ResponseWriter) { succeed(w) })
		var sleeps []time.Duration
		enrollOrFail(t, enrollInput(stub, &sleeps))

		var body map[string]any
		if err := json.Unmarshal(stub.seen()[0].body, &body); err != nil {
			t.Fatalf("body is not JSON: %v", err)
		}
		// ValidationPipe({whitelist, forbidNonWhitelisted}) turns an undeclared
		// property into a 400 for EVERY install, so a sixth field here is a fleet
		// outage against any API deployed before it.
		declared := map[string]bool{"code": true, "hostname": true, "os": true, "arch": true, "agentVersion": true}
		for key := range body {
			if !declared[key] {
				t.Fatalf("body carries %q, which EnrollAgentDto does not declare (the API answers 400)", key)
			}
		}
		for key, want := range map[string]string{
			"code": enrollCode, "hostname": "workshop-mini",
			"os": "linux", "arch": "arm64", "agentVersion": "9.9.9",
		} {
			if body[key] != want {
				t.Fatalf("body[%q] = %v, want %q", key, body[key], want)
			}
		}
	})

	t.Run("[TC-PDAGENT-071] builds the endpoint from whatever --server was typed", func(t *testing.T) {
		for _, server := range []string{
			"https://pdmux.example.com",
			"https://pdmux.example.com/",
			"pdmux.example.com",
			// The exact WebSocket endpoint: the agent path is stripped, not appended to.
			"wss://pdmux.example.com/agent/ws",
		} {
			got, err := EnrollURL(server)
			if err != nil {
				t.Fatalf("EnrollURL(%q): %v", server, err)
			}
			if got != "https://pdmux.example.com"+EnrollPath {
				t.Fatalf("EnrollURL(%q) = %q", server, got)
			}
		}
		// A path prefix is kept, so a server mounted under a sub-path still works.
		if got, _ := EnrollURL("https://example.com/pdmux"); got != "https://example.com/pdmux"+EnrollPath {
			t.Fatalf("prefixed server = %q", got)
		}
		if _, err := EnrollURL("ftp://pdmux.example.com"); err == nil {
			t.Fatal("an unusable scheme must be refused, not guessed at")
		}
	})
}

func TestEnrollTerminalRefusals(t *testing.T) {
	// One answer, believed. A consumed code does not become valid, a disabled host
	// is a human decision, and hammering a throttle extends the block.
	cases := []struct {
		name     string
		status   int
		code     string
		message  string
		exitCode int
	}{
		{"401 invalid code", http.StatusUnauthorized, "ENROLL_CODE_INVALID", "Enrollment code is not valid", exitEnrollRejected},
		{"409 host disabled", http.StatusConflict, "HOST_DISABLED", "This host is disabled", exitEnrollHostDisabled},
		// The throttler guard is a plain HttpException, so the envelope carries the
		// generic code — which is why the exit code is keyed on the status.
		{"429 throttled", http.StatusTooManyRequests, "HTTP_ERROR", "ThrottlerException: Too Many Requests", exitEnrollThrottled},
		// Not one of the three named codes, but still terminal: a 400 is a field
		// this build sends that the deployed API does not declare.
		{"400 rejected body", http.StatusBadRequest, "HTTP_ERROR", "property extra should not exist", exitFailed},
	}
	for _, tc := range cases {
		t.Run("[TC-PDAGENT-071] does not retry a "+tc.name, func(t *testing.T) {
			stub := newEnrollStub(t, func(_ int, w http.ResponseWriter) { refuse(w, tc.status, tc.code, tc.message) })
			var sleeps []time.Duration
			refusal := refusalOrFail(t, enrollInput(stub, &sleeps))

			if stub.count() != 1 {
				t.Fatalf("made %d requests, want exactly 1 — this failure is terminal", stub.count())
			}
			if len(sleeps) != 0 {
				t.Fatalf("waited %v before giving up on a terminal failure", sleeps)
			}
			if refusal.ExitCode != tc.exitCode {
				t.Fatalf("exit code = %d, want %d", refusal.ExitCode, tc.exitCode)
			}
			if refusal.Status != tc.status || refusal.Code != tc.code {
				t.Fatalf("refusal = %+v", refusal)
			}
			// The server's own message is what reaches the operator; it knows which
			// of the reasons applied and this build does not.
			if !strings.Contains(refusal.Message, tc.message) {
				t.Fatalf("message = %q, want the server's %q", refusal.Message, tc.message)
			}
		})
	}
}

func TestEnrollRetries(t *testing.T) {
	t.Run("[TC-PDAGENT-071] retries a 5xx and succeeds", func(t *testing.T) {
		stub := newEnrollStub(t, func(attempt int, w http.ResponseWriter) {
			if attempt < 2 {
				refuse(w, http.StatusBadGateway, "INTERNAL_ERROR", "Internal server error")
				return
			}
			succeed(w)
		})
		var sleeps []time.Duration
		result := enrollOrFail(t, enrollInput(stub, &sleeps))
		if result.Token != enrolledToken {
			t.Fatalf("token = %q", result.Token)
		}
		if stub.count() != 3 {
			t.Fatalf("made %d requests, want 3", stub.count())
		}
		if len(sleeps) != 2 || sleeps[0] != 2*time.Second || sleeps[1] != 5*time.Second {
			t.Fatalf("backoff = %v, want [2s 5s]", sleeps)
		}
	})

	t.Run("[TC-PDAGENT-071] gives up after the last backoff", func(t *testing.T) {
		stub := newEnrollStub(t, func(_ int, w http.ResponseWriter) {
			refuse(w, http.StatusServiceUnavailable, "INTERNAL_ERROR", "Internal server error")
		})
		var sleeps []time.Duration
		refusal := refusalOrFail(t, enrollInput(stub, &sleeps))
		if stub.count() != len(enrollBackoff)+1 {
			t.Fatalf("made %d requests, want %d", stub.count(), len(enrollBackoff)+1)
		}
		if len(sleeps) != 3 || sleeps[0] != 2*time.Second || sleeps[1] != 5*time.Second || sleeps[2] != 10*time.Second {
			t.Fatalf("backoff = %v, want [2s 5s 10s]", sleeps)
		}
		if refusal.ExitCode != exitFailed {
			t.Fatalf("exit code = %d, want %d", refusal.ExitCode, exitFailed)
		}
	})

	t.Run("[TC-PDAGENT-071] retries a connection failure", func(t *testing.T) {
		// A server that is not there: the address is real, nothing is listening.
		stub := newEnrollStub(t, func(_ int, w http.ResponseWriter) { succeed(w) })
		stub.server.Close()

		var sleeps []time.Duration
		refusal := refusalOrFail(t, enrollInput(stub, &sleeps))
		if len(sleeps) != 3 {
			t.Fatalf("backoff = %v, want three retries", sleeps)
		}
		if refusal.Status != 0 || refusal.ExitCode != exitFailed {
			t.Fatalf("refusal = %+v", refusal)
		}
		if !strings.Contains(refusal.Message, "cannot reach") {
			t.Fatalf("message = %q", refusal.Message)
		}
	})
}

func TestEnrollRefusesRedirects(t *testing.T) {
	t.Run("[TC-PDAGENT-071] never replays the code at a redirect target", func(t *testing.T) {
		// Where a 307 would send the body. http.Client REPLAYS a POST body on 307
		// and 308, so following one hands a live credential to another host.
		elsewhere := newEnrollStub(t, func(_ int, w http.ResponseWriter) { succeed(w) })
		origin := newEnrollStub(t, func(_ int, w http.ResponseWriter) {
			w.Header().Set("location", elsewhere.url+EnrollPath)
			w.WriteHeader(http.StatusTemporaryRedirect)
		})

		var sleeps []time.Duration
		refusal := refusalOrFail(t, enrollInput(origin, &sleeps))

		if elsewhere.count() != 0 {
			t.Fatalf("the redirect target received %d requests — the code was handed to another host", elsewhere.count())
		}
		if origin.count() != 1 || len(sleeps) != 0 {
			t.Fatalf("requests = %d, backoff = %v — a redirect refusal is terminal", origin.count(), sleeps)
		}
		if !strings.Contains(refusal.Message, "redirect") {
			t.Fatalf("message = %q, want it to name the redirect", refusal.Message)
		}
		if strings.Contains(refusal.Message, enrollCode) {
			t.Fatalf("the refusal printed the code: %q", refusal.Message)
		}
	})
}

func TestCommandInstallEnroll(t *testing.T) {
	t.Run("[TC-PDAGENT-071] refuses --code and --token together", func(t *testing.T) {
		stub := newEnrollStub(t, func(_ int, w http.ResponseWriter) { succeed(w) })
		h := newHarness(t)
		code := h.run("install", "--server", stub.url, "--code", enrollCode, "--token", commandToken, "--user")
		if code != exitRefused {
			t.Fatalf("exit = %d, want %d", code, exitRefused)
		}
		if stub.count() != 0 {
			t.Fatal("a usage error must not spend the code")
		}
		if !strings.Contains(h.stderr.String(), "both --code and --token") {
			t.Fatalf("stderr = %s", h.stderr.String())
		}
	})

	t.Run("[TC-PDAGENT-071] exits on the server's code so a script can branch", func(t *testing.T) {
		stub := newEnrollStub(t, func(_ int, w http.ResponseWriter) {
			refuse(w, http.StatusConflict, "HOST_DISABLED", "This host is disabled")
		})
		h := newHarness(t)
		if code := h.run("install", "--server", stub.url, "--code", enrollCode, "--user"); code != exitEnrollHostDisabled {
			t.Fatalf("exit = %d, want %d, stderr = %s", code, exitEnrollHostDisabled, h.stderr.String())
		}
		if !strings.Contains(h.stderr.String(), "This host is disabled") {
			t.Fatalf("stderr = %s", h.stderr.String())
		}
		// A refused enrollment writes nothing: a config file with no token in it
		// would start a unit that fails authentication and restarts forever.
		if _, err := os.Stat(filepath.Join(h.home, ".config", "pdmux", "agent.json")); !os.IsNotExist(err) {
			t.Fatal("a refused enrollment wrote a config file")
		}
	})

	t.Run("[TC-PDAGENT-072] a dry run does not redeem the code", func(t *testing.T) {
		stub := newEnrollStub(t, func(_ int, w http.ResponseWriter) { succeed(w) })
		h := newHarness(t)
		if code := h.run("install", "--server", stub.url, "--code", enrollCode, "--user", "--dry-run"); code != exitOK {
			t.Fatalf("exit = %d, stderr = %s", code, h.stderr.String())
		}
		// THE POINT: a code is single use, so a rehearsal that spent it would make
		// the real run fail with "code is not valid".
		if stub.count() != 0 {
			t.Fatalf("a dry run sent %d requests — the code is single use", stub.count())
		}
		out := h.stdout.String()
		if !strings.Contains(out, "NOT redeemed") {
			t.Fatalf("a dry run must say the code is untouched:\n%s", out)
		}
		if !strings.Contains(out, EnrollPath) {
			t.Fatalf("a dry run must name the endpoint it would call:\n%s", out)
		}
		if _, err := os.Stat(filepath.Join(h.home, ".config", "pdmux", "agent.json")); !os.IsNotExist(err) {
			t.Fatal("--dry-run must write nothing")
		}
	})

	t.Run("[TC-PDAGENT-072] prints neither the code nor the token", func(t *testing.T) {
		stub := newEnrollStub(t, func(_ int, w http.ResponseWriter) { succeed(w) })
		h := newHarness(t)
		if code := h.run("install", "--server", stub.url, "--code", enrollCode, "--user"); code != exitOK {
			t.Fatalf("exit = %d, stderr = %s", code, h.stderr.String())
		}
		for name, stream := range map[string]string{"stdout": h.stdout.String(), "stderr": h.stderr.String()} {
			if strings.Contains(stream, enrolledToken) {
				t.Fatalf("%s printed the token:\n%s", name, stream)
			}
			if strings.Contains(stream, enrollCode) {
				t.Fatalf("%s printed the enrollment code:\n%s", name, stream)
			}
		}
		// The token went exactly one way: response body -> process -> 0600 file.
		configPath := filepath.Join(h.home, ".config", "pdmux", "agent.json")
		info, err := os.Stat(configPath)
		if err != nil {
			t.Fatalf("config was not written: %v", err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("config mode = %04o", info.Mode().Perm())
		}
		written, err := os.ReadFile(configPath)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(written), enrolledToken) {
			t.Fatalf("the enrolled token did not reach the config file:\n%s", written)
		}
		// The unit is world-readable, so it must carry the path and not the secret.
		unit, err := os.ReadFile(filepath.Join(h.home, ".config", "systemd", "user", UnitName))
		if err != nil {
			t.Fatalf("unit was not written: %v", err)
		}
		if strings.Contains(string(unit), enrolledToken) || strings.Contains(string(unit), enrollCode) {
			t.Fatalf("unit carries a credential:\n%s", unit)
		}
		// Confirmation the operator needs: which host row was just claimed.
		if !strings.Contains(h.stdout.String(), enrolledHostID) {
			t.Fatalf("stdout does not name the enrolled host:\n%s", h.stdout.String())
		}
	})

	t.Run("[TC-PDAGENT-072] keeps the token out of every log line", func(t *testing.T) {
		stub := newEnrollStub(t, func(attempt int, w http.ResponseWriter) {
			// A retry first, so the warning line the retry writes is covered too.
			if attempt == 0 {
				refuse(w, http.StatusBadGateway, "INTERNAL_ERROR", "Internal server error")
				return
			}
			succeed(w)
		})
		var lines []string
		var sleeps []time.Duration
		in := enrollInput(stub, &sleeps)
		in.Logger = newRecordingLogger(&lines)

		result := enrollOrFail(t, in)
		if result.Token != enrolledToken {
			t.Fatalf("token = %q", result.Token)
		}
		// Both secrets were registered the moment they existed, so even a line
		// written by code with no idea a credential is in scope prints *** instead.
		in.Logger.Info("Deliberately careless", log.F("detail", "token="+result.Token))
		in.Logger.Info("Deliberately careless again", log.F("detail", "code "+enrollCode+" redeemed"))
		for _, line := range lines {
			if strings.Contains(line, enrolledToken) {
				t.Fatalf("a log line carries the token: %s", line)
			}
			if strings.Contains(line, enrollCode) {
				t.Fatalf("a log line carries the enrollment code: %s", line)
			}
		}
		if len(lines) == 0 {
			t.Fatal("nothing was logged, so nothing was proven")
		}
	})
}

func TestEnrollAcceptsCreated(t *testing.T) {
	t.Run("[TC-PDAGENT-071] treats 201 Created as success, because that is what the server sends", func(t *testing.T) {
		// A creating POST answers 201, and the exchange creates a token. Comparing
		// the status to 200 for equality stopped the installer one step from done —
		// AND burned the single-use code, so the retry could not work either. Found
		// by running the real installer end to end; neither half's own tests saw it,
		// because each mocked the other's status.
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"hostId":"h1","hostLabel":"local-dev","token":"pdmux_x","tokenId":"t1","tokenName":"installer"}`))
		}))
		defer server.Close()

		result, err := Enroll(context.Background(), EnrollInput{
			Server: server.URL,
			Code:   enrollCode,
		})
		if err != nil {
			t.Fatalf("201 must be a success, got error: %v", err)
		}
		if result.Token != "pdmux_x" || result.HostLabel != "local-dev" {
			t.Fatalf("unexpected result: %+v", result)
		}
	})
}
