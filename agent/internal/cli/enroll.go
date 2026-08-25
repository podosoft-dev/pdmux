// `pdmux-agent install --code pdmxe_…` — trade a short-lived enrollment code for
// the long-lived host token, then install exactly as `--token` already does.
//
// ⚠ WHY THE EXCHANGE LIVES IN THIS BINARY AND NOT IN install.sh. This is the one
// property the file exists to preserve; everything else here is detail.
//
// The public installer is
//
//	curl -fsSL https://pdmux.example.com/install.sh | sh -s -- --code pdmxe_…
//
// and anything the SHELL holds is visible to every other account on that machine:
// argv is world-readable through `ps`, and a temp file is world-readable for as
// long as it exists. If the script did the POST it would have to scrape the token
// out of the JSON with sed and then hand it to this binary — through argv or
// through a file — and it is the LONG-LIVED credential that would take that trip.
// Doing it here means the only secret ever exposed that way is the CODE, which is
// single-use and dead in fifteen minutes, and the token travels exactly one path:
//
//	HTTPS response body -> this process -> the 0600 config file
//
// Never move this into the script, and never let the token reach argv, an
// environment variable of a child process, or a file that is not the config file.
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/config"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// EnrollPath is the redemption endpoint, relative to the server origin.
//
// The `/api` prefix belongs to the WEB TIER, not to the API: the controller is
// `@Controller("agent") @Post("enroll")` and the API sets no global prefix, but
// `--server` is the public origin a human pastes from their browser, and there
// SvelteKit's `/api/[...path]` route is what forwards to the API. Pointing an
// agent straight at the API port is a development shortcut, not the contract.
const EnrollPath = "/api/agent/enroll"

// EnrollCodePrefix is the code's marker. Distinct from the token's `pdmux_` so a
// human never has to work out which of the two strings they are holding.
// Mirrors ENROLLMENT_CODE_PREFIX in apps/api/src/agents/agent-enrollment.crypto.ts.
const EnrollCodePrefix = "pdmxe_"

// enrollTimeout bounds ONE attempt. The exchange is a single small round trip; a
// server that has not answered in this long is not about to.
const enrollTimeout = 20 * time.Second

// enrollBodyLimit caps what is read back. The success body is a few hundred bytes
// and the error envelope less, so this only exists to keep a hostile or broken
// server from streaming into memory forever.
const enrollBodyLimit = 64 << 10

// enrollBackoff is the wait before each RETRY — three of them, so at most four
// requests and roughly seventeen seconds before the installer gives up.
//
// ⚠ ONLY A CONNECTION FAILURE OR A 5xx GETS HERE (see EnrollError.Retryable).
// A 401 is a code that is malformed, unknown, expired, already spent or revoked
// and none of those become valid by asking again; a 409 is a host an operator has
// to enable; and a 429 is a rate limit that retrying makes strictly worse. Those
// three are terminal on the first answer.
var enrollBackoff = []time.Duration{2 * time.Second, 5 * time.Second, 10 * time.Second}

// EnrollRequest is the JSON body of POST /api/agent/enroll.
//
// ⚠ THE CODE TRAVELS IN THE BODY, NOT IN A HEADER. The web tier forwards a fixed
// allowlist of request headers to the API (apps/web/src/lib/server/backend-proxy.ts,
// FORWARDED_HEADERS = authorization, cookie, content-type, accept, origin,
// referer), so a custom header does not arrive at all — the API would see a
// request with no credential in it and answer 401 for a perfectly good code.
//
// ⚠ THESE FIVE FIELDS AND NO OTHERS. The API runs
// `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`, so a property
// EnrollAgentDto does not declare is a **400**, not a silently dropped extra. An
// agent that starts sending a sixth field therefore fails against every API that
// has not been deployed first: add it to the DTO, deploy, and only then send it.
type EnrollRequest struct {
	Code string `json:"code"`
	// The rest are what the machine says it is, recorded in the server's audit
	// entry so an operator can tell whether the box that redeemed the code is the
	// box they meant. They are not authoritative — the host row's os, arch and
	// version come from the agent's `hello` frame once it connects.
	Hostname     string `json:"hostname,omitempty"`
	OS           string `json:"os,omitempty"`
	Arch         string `json:"arch,omitempty"`
	AgentVersion string `json:"agentVersion,omitempty"`
}

// EnrollResult is the 200 body: everything the installer needs to write its
// config file, plus the identifiers it prints so a human can confirm which host
// row they just claimed.
type EnrollResult struct {
	HostID    string `json:"hostId"`
	HostLabel string `json:"hostLabel"`
	Token     string `json:"token"`
	TokenID   string `json:"tokenId"`
	TokenName string `json:"tokenName"`
}

// errorEnvelope is the API's stable error shape
// (apps/api/src/common/all-exceptions.filter.ts). Only the fields this decides on
// are named; the rest of the envelope is ignored rather than rejected.
type errorEnvelope struct {
	Error struct {
		Code       string `json:"code"`
		Message    string `json:"message"`
		StatusCode int    `json:"statusCode"`
	} `json:"error"`
}

// EnrollError is a refusal the caller can branch on — and, through ExitCode, so
// can the shell script that invoked us.
type EnrollError struct {
	// Status is the HTTP status, or 0 when the request never got an answer.
	Status int
	// Code is the server's `error.code` (ENROLL_CODE_INVALID, HOST_DISABLED, …),
	// empty for a transport failure or a throttler rejection.
	Code string
	// Message is what the process prints. It is the server's message whenever
	// there is one, because the server knows things this build does not.
	Message string
	// ExitCode is what Main returns for this failure.
	ExitCode int
	// Retryable is true only for "ask again later" failures: no connection, or a
	// 5xx. Everything else is answered once and believed.
	Retryable bool
}

func (e *EnrollError) Error() string { return e.Message }

// EnrollInput is one exchange. Every dependency is injectable so a spec can drive
// a real httptest server without waiting out the backoff.
type EnrollInput struct {
	// Server is whatever the operator typed as --server; see EnrollURL.
	Server string
	Code   string
	// Hostname is what to report; empty omits the field.
	Hostname string
	// OS, Arch and Version default to this build's values.
	OS, Arch, Version string
	// Client is the HTTP client; nil builds the redirect-refusing default.
	Client *http.Client
	// Sleep waits between retries; nil uses time.Sleep.
	Sleep func(time.Duration)
	// Logger is where the token is registered as a secret the moment it exists.
	Logger *log.Logger
}

// errRefusedRedirect marks the one transport failure that must NOT be retried:
// retrying it would just send the code to the same wrong host again.
var errRefusedRedirect = errors.New("refused to follow a redirect")

// refuseRedirect is the client's CheckRedirect.
//
// ⚠ LOAD-BEARING. http.Client follows a 307/308 by REPLAYING THE REQUEST BODY at
// the new location — and the body is the enrollment code. A misconfigured (or
// hostile) server answering `307 Location: https://elsewhere/` would therefore be
// handed a live credential by us, silently, with a 200 at the end to make it look
// like it worked. The redemption is a single POST to a single known origin, so
// there is no legitimate redirect to accommodate: refuse, loudly.
func refuseRedirect(request *http.Request, _ []*http.Request) error {
	return fmt.Errorf("%w to %s", errRefusedRedirect, request.URL.Redacted())
}

func enrollClient() *http.Client {
	return &http.Client{Timeout: enrollTimeout, CheckRedirect: refuseRedirect}
}

// EnrollURL is the endpoint a code is redeemed at, derived from whatever the
// operator typed as --server.
//
// It is built FROM ToWebSocketURL rather than beside it. `--server` tolerates a
// bare host, an http(s) origin, a ws(s) URL, a trailing slash and a path prefix,
// and that tolerance is a regexp plus four branches that must not exist in two
// places and drift. Deriving this URL from the WebSocket one makes the two
// endpoints the same server by construction.
//
// http stays http so a development stack on localhost works. The code is then on
// the wire in clear text — which is exactly why the public installer's one-liner
// names an https origin.
func EnrollURL(server string) (string, error) {
	socket, err := config.ToWebSocketURL(server)
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(socket)
	if err != nil {
		return "", fmt.Errorf("unusable server address %q: %w", server, err)
	}
	switch parsed.Scheme {
	case "wss":
		parsed.Scheme = "https"
	case "ws":
		parsed.Scheme = "http"
	}
	// ToWebSocketURL appended the agent path (or left one the operator typed);
	// strip it back off so a `--server` that names the exact WebSocket endpoint
	// resolves to the right origin instead of /agent/ws/api/agent/enroll.
	parsed.Path = strings.TrimSuffix(parsed.Path, protocol.AgentWSPath) + EnrollPath
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

// Enroll exchanges the code for a token.
//
// It returns *EnrollError for every failure, so the caller has a message to print
// and an exit code to return without inspecting the error text.
func Enroll(ctx context.Context, in EnrollInput) (EnrollResult, error) {
	logger := in.Logger
	if logger == nil {
		logger = log.Silent()
	}
	// The CODE is a credential too — shorter-lived than the token, but live until
	// it is spent. Registered here as well as at the command layer so the property
	// holds for every caller, not only the one that happens to remember.
	logger.AddSecret(strings.TrimSpace(in.Code))

	endpoint, err := EnrollURL(in.Server)
	if err != nil {
		// A server address this build cannot parse is a refusal to act, not a
		// failure to reach anything: nothing was sent, and retrying cannot help.
		return EnrollResult{}, &EnrollError{Message: err.Error(), ExitCode: exitRefused}
	}

	body, err := json.Marshal(EnrollRequest{
		// Trimmed here as well as server-side: a code pasted out of a chat window
		// arrives with a newline attached often enough to be worth one call.
		Code:         strings.TrimSpace(in.Code),
		Hostname:     in.Hostname,
		OS:           orDefault(in.OS, runtime.GOOS),
		Arch:         orDefault(in.Arch, runtime.GOARCH),
		AgentVersion: orDefault(in.Version, AgentVersion),
	})
	if err != nil {
		return EnrollResult{}, &EnrollError{Message: fmt.Sprintf("cannot encode the enrollment request: %v", err), ExitCode: exitRefused}
	}

	client := in.Client
	if client == nil {
		client = enrollClient()
	}
	sleep := in.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}

	for attempt := 0; ; attempt++ {
		result, failure := attemptEnroll(ctx, client, endpoint, body, logger)
		if failure == nil {
			return result, nil
		}
		if !failure.Retryable || attempt >= len(enrollBackoff) {
			return EnrollResult{}, failure
		}
		wait := enrollBackoff[attempt]
		logger.Warn("Retrying the enrollment exchange",
			log.F("attempt", attempt+1), log.F("in", wait.String()), log.F("reason", failure.Message))
		sleep(wait)
		if err := ctx.Err(); err != nil {
			return EnrollResult{}, &EnrollError{Message: fmt.Sprintf("enrollment was interrupted: %v", err), ExitCode: exitFailed}
		}
	}
}

// attemptEnroll is one request. It never retries and never sleeps, so the policy
// above is the only place that decides how many times anything happens.
func attemptEnroll(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	body []byte,
	logger *log.Logger,
) (EnrollResult, *EnrollError) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return EnrollResult{}, &EnrollError{Message: fmt.Sprintf("cannot build the enrollment request: %v", err), ExitCode: exitRefused}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "pdmux-agent/"+AgentVersion)

	response, err := client.Do(request)
	if err != nil {
		if errors.Is(err, errRefusedRedirect) {
			return EnrollResult{}, &EnrollError{
				Message: fmt.Sprintf(
					"%v — the enrollment code is only ever sent to the server it was issued by, and a 307/308 replays the request body at the new location",
					err),
				ExitCode: exitFailed,
			}
		}
		// No answer at all: a DNS blip, a server still booting, a proxy that has
		// not come up yet. This is the case retrying exists for.
		return EnrollResult{}, &EnrollError{
			Message:   fmt.Sprintf("cannot reach %s: %v", endpoint, err),
			ExitCode:  exitFailed,
			Retryable: true,
		}
	}
	defer response.Body.Close()

	payload, readErr := io.ReadAll(io.LimitReader(response.Body, enrollBodyLimit))
	if readErr != nil && isEnrollSuccess(response.StatusCode) {
		// A success cut off mid-body may still have consumed the code server-side,
		// but the token is what we came for and we do not have it. Retrying costs
		// one 401 in the worst case and recovers a flaky read in the best.
		return EnrollResult{}, &EnrollError{
			Status:    response.StatusCode,
			Message:   fmt.Sprintf("the server's answer was cut off: %v", readErr),
			ExitCode:  exitFailed,
			Retryable: true,
		}
	}

	if isEnrollSuccess(response.StatusCode) {
		var result EnrollResult
		if err := json.Unmarshal(payload, &result); err != nil {
			return EnrollResult{}, &EnrollError{
				Status:   response.StatusCode,
				Message:  fmt.Sprintf("the server accepted the code but sent an answer this build cannot read: %v", err),
				ExitCode: exitFailed,
			}
		}
		if result.Token == "" {
			return EnrollResult{}, &EnrollError{
				Status:   response.StatusCode,
				Message:  "the server accepted the code but returned no token",
				ExitCode: exitFailed,
			}
		}
		// ⚠ FIRST THING DONE WITH THE TOKEN, BEFORE IT IS RETURNED ANYWHERE. From
		// here on any log line that manages to carry it prints *** instead —
		// including ones written by code that has no idea a secret is in scope.
		logger.AddSecret(result.Token)
		return result, nil
	}

	var envelope errorEnvelope
	// A body that is not the envelope (an HTML error page from a proxy in front of
	// the server, say) leaves the zero value, and refusalMessage falls back to the
	// status. Nothing here depends on the parse succeeding.
	_ = json.Unmarshal(payload, &envelope)

	if response.StatusCode >= 500 {
		return EnrollResult{}, &EnrollError{
			Status:    response.StatusCode,
			Code:      envelope.Error.Code,
			Message:   refusalMessage(response.StatusCode, envelope),
			ExitCode:  exitFailed,
			Retryable: true,
		}
	}
	// Every 4xx is terminal, not just the three with a named exit code: a 400 is a
	// field this build sends that the deployed API does not declare, and a 404 is
	// the wrong origin. Asking again changes neither.
	return EnrollResult{}, &EnrollError{
		Status:   response.StatusCode,
		Code:     envelope.Error.Code,
		Message:  refusalMessage(response.StatusCode, envelope),
		ExitCode: enrollExitCode(response.StatusCode),
	}
}

// enrollExitCode maps a refusal onto the process exit code install.sh branches on.
//
// Keyed on the STATUS rather than on error.code: 401 and 409 carry
// ENROLL_CODE_INVALID and HOST_DISABLED, but a 429 comes from the throttler guard
// and arrives with the generic HTTP_ERROR code, so the status is the only axis all
// three share.
func enrollExitCode(status int) int {
	switch status {
	case http.StatusUnauthorized:
		return exitEnrollRejected
	case http.StatusConflict:
		return exitEnrollHostDisabled
	case http.StatusTooManyRequests:
		return exitEnrollThrottled
	default:
		return exitFailed
	}
}

// refusalMessage prefers the server's own wording — it knows things this build
// does not — and adds the "so what do I do now" the server has no room for.
//
// The three hints are facts of the server's implementation, not guesses:
// ENROLLMENT_TTL_MS is fifteen minutes, a disabled host is refused WITHOUT
// consuming the code (agent-enrollments.service.ts says so in as many words), and
// the endpoint is throttled at ten attempts a minute per client address.
func refusalMessage(status int, envelope errorEnvelope) string {
	message := envelope.Error.Message
	if message == "" {
		message = fmt.Sprintf("the server refused the enrollment code (HTTP %d)", status)
	}
	switch status {
	case http.StatusUnauthorized:
		return message + " — a code expires 15 minutes after it is shown and can only be redeemed once; generate a new one for this host and run install again"
	case http.StatusConflict:
		return message + " — enable the host, then run install again with the SAME code: a disabled host is refused without consuming it"
	case http.StatusTooManyRequests:
		return message + " — wait a minute and run install again; retrying in a loop only extends the block"
	default:
		return message
	}
}

func orDefault(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

// isEnrollSuccess accepts any 2xx.
//
// ⚠ NOT `== 200`. The exchange is a POST that creates a token, and the API answers a
// creating POST with **201 Created** — which an equality check reads as a refusal,
// so the installer stops one step from done with "the server refused the enrollment
// code (HTTP 201)" while the server has already spent the single-use code. Found by
// running the real installer end to end; neither half's own tests could see it,
// because each mocked the other's status.
func isEnrollSuccess(status int) bool {
	return status >= 200 && status < 300
}
