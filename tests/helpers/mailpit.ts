import { request, test } from "@playwright/test";

// Helpers for the local Mailpit catcher (docker-compose / CI service). Each test
// mails an address of its own and reads the newest message to it; the inbox is
// shared with tests on other workers, so no test empties it.
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const PROBE_WAIT_MS = 5000;

type MailpitList = { messages: Array<{ ID: string; To: Array<{ Address: string }> }> };
type MailpitMessage = { Text?: string; HTML?: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function newestMessageTo(to: string): Promise<string | undefined> {
  const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as MailpitList;
  return list.messages?.find((m) => m.To?.some((t) => t.Address === to))?.ID;
}

// A Mailpit answering on MAILPIT_URL may belong to another stack while this app
// sends no mail or sends it elsewhere, so ask the app to mail an address of the
// probe's own and wait for that message. Returns why email tests cannot run, or
// null when the message arrives.
async function mailDeliveryProblem(): Promise<string | null> {
  try {
    if (!(await fetch(`${MAILPIT}/readyz`)).ok) return `Mailpit at ${MAILPIT} is not ready`;
  } catch {
    return `no Mailpit answers at ${MAILPIT}`;
  }
  const email = `mail-probe-${Date.now()}-${process.pid}@example.com`;
  const app = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  try {
    const signUp = await app.post("/api/auth/sign-up/email", {
      data: { email, password: "Podokit3e-Str0ng!pw", name: "Mail probe" },
    });
    if (!signUp.ok()) return `the mail probe could not sign up (HTTP ${signUp.status()})`;
    const reset = await app.post("/api/auth/request-password-reset", {
      data: { email, redirectTo: `${base}/reset-password` },
    });
    if (!reset.ok()) return `the app could not send the probe email (HTTP ${reset.status()})`;
  } finally {
    await app.dispose();
  }
  const deadline = Date.now() + PROBE_WAIT_MS;
  while (Date.now() < deadline) {
    if (await newestMessageTo(email)) return null;
    await sleep(250);
  }
  return `Mailpit at ${MAILPIT} does not receive this app's mail: a probe email to ${email} did not arrive within ${PROBE_WAIT_MS / 1000} s`;
}

let delivery: Promise<string | null> | undefined;

/**
 * Skip the current test unless the app under test delivers its mail to the
 * Mailpit these helpers read. The probe runs once per worker. With
 * E2E_REQUIRE_MAIL=true, which a harness that wires the app's SMTP to that
 * Mailpit sets, a failed probe fails the test instead.
 */
export async function skipUnlessMailReachesMailpit(): Promise<void> {
  delivery ??= mailDeliveryProblem().catch((error: unknown) => `the mail probe failed: ${String(error)}`);
  const problem = await delivery;
  if (problem === null) return;
  if (process.env.E2E_REQUIRE_MAIL === "true") throw new Error(`E2E_REQUIRE_MAIL is set, but ${problem}`);
  test.skip(true, problem);
}

// Poll for the newest message addressed to `to` and return the first match of
// `pattern` in its text/HTML body.
async function waitForMatch(to: string, pattern: RegExp, label: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await newestMessageTo(to);
    if (id) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as MailpitMessage;
      const match = `${full.Text ?? ""} ${full.HTML ?? ""}`.match(pattern);
      if (match) return match[0];
    }
    await sleep(300);
  }
  throw new Error(`no email with ${label} to ${to} within ${timeoutMs}ms`);
}

/** The first link in the newest email addressed to `to`. */
export function waitForLink(to: string, timeoutMs = 10000): Promise<string> {
  return waitForMatch(to, /https?:\/\/[^\s"<>]+/, "a link", timeoutMs);
}

/** The one-time numeric code in the newest email addressed to `to`. */
export function waitForOtp(to: string, timeoutMs = 10000): Promise<string> {
  return waitForMatch(to, /\b\d{4,8}\b/, "a one-time code", timeoutMs);
}
