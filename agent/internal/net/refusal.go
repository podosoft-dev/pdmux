package net

// Why the server would not take this agent — and, just as importantly, whether
// dialling again on the ordinary schedule can ever change that answer.
//
// ⚠ BOTH FACTS USED TO BE THROWN AWAY AT THE POINT THEY WERE LEARNED. The read
// loop's close code went through closeReason(), which formatted the number into
// a log string and never compared it to anything; an auth refusal is not a close
// code at all — it happens at the HTTP upgrade — and the status went into `_`
// while the text became "connect failed: …". So a host whose token had been
// revoked was indistinguishable, in the log and on disk, from a host whose
// server was briefly down: both retried every thirty seconds forever.
//
// ⚠ THE VOCABULARY IS DELIBERATELY COARSE, because the agent's knowledge is. A
// 401 at the upgrade cannot tell a missing key from an unknown one from a
// revoked or an expired one — the server answers all four identically ON PURPOSE
// so that an attacker cannot use the difference — so the agent records `refused`
// rather than inventing a certainty it does not have. The specific reasons are
// used only for the close codes it genuinely receives.

import (
	"net/http"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// Reason is what the agent can honestly say about how a session ended.
type Reason string

const (
	// ReasonNone is an ordinary drop: a server restart, a proxy idle timeout, a
	// laptop's network changing. Nobody decided anything about this host.
	ReasonNone Reason = ""
	// ReasonRefused is 401/403 at the upgrade — the four token failures the server
	// refuses to tell apart, plus a gateway in front of it that said no.
	ReasonRefused Reason = "refused"
	// ReasonReplaced is close 4000: another connection took this host's slot.
	ReasonReplaced Reason = "replaced"
	// ReasonHostDisabled is close 4002: somebody turned this host off.
	ReasonHostDisabled Reason = "host_disabled"
	// ReasonTokenRevoked is close 4003.
	ReasonTokenRevoked Reason = "token_revoked"
	// ReasonHostDeleted is close 4004: the row this agent reports into is gone.
	ReasonHostDeleted Reason = "host_deleted"
)

// Terminal reports whether retrying on the ordinary schedule could ever change
// the answer.
//
// It cannot for any of these: every one needs a PERSON — a host re-enabled, a
// host re-created, a fresh token installed. The agent still never gives up
// (`Restart=always` has to mean always, and a host that is re-enabled must come
// back without somebody SSHing into it), it simply stops asking every thirty
// seconds for something only a human can grant.
//
// ⚠ `replaced` IS NOT TERMINAL, and that is a decision rather than an omission.
// Losing the slot to another connection is a race, not a refusal: the winner may
// be a stale socket the server is about to sweep, and the loser has to be dialling
// on the ordinary schedule when that happens or the host stays dark for a quarter
// of an hour over a two-second overlap.
func (r Reason) Terminal() bool {
	switch r {
	case ReasonRefused, ReasonHostDisabled, ReasonTokenRevoked, ReasonHostDeleted:
		return true
	default:
		return false
	}
}

// reasonForStatus classifies a refused HTTP upgrade.
//
// Only the two statuses that mean "I know who you claim to be and no". Anything
// else — a 502 from a proxy, a 302 to an auth gateway's login page, a 404 from a
// server that does not serve this path — is a deployment being wrong, which is
// transient by nature and must keep the ordinary schedule.
func reasonForStatus(status int) Reason {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return ReasonRefused
	default:
		return ReasonNone
	}
}

// reasonForClose maps a close code onto a reason.
//
// The codes come from the generated contract rather than from literals here:
// they are values a schema cannot express, so a second copy would be free to
// drift from the number the server actually sends — and drift here is silent,
// because an unrecognised code simply looks like an ordinary drop.
func reasonForClose(code int) Reason {
	switch code {
	case protocol.AgentCloseReplaced:
		return ReasonReplaced
	case protocol.AgentCloseHostDisabled:
		return ReasonHostDisabled
	case protocol.AgentCloseTokenRevoked:
		return ReasonTokenRevoked
	case protocol.AgentCloseHostDeleted:
		return ReasonHostDeleted
	default:
		return ReasonNone
	}
}
