// Helpers for the local Mailpit catcher (docker-compose / CI service). Tests that
// exercise email flows skip when it isn't reachable (see MAILPIT_URL).
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

export async function mailpitReachable(): Promise<boolean> {
  try {
    return (await fetch(`${MAILPIT}/readyz`)).ok;
  } catch {
    return false;
  }
}

export async function clearMailpit(): Promise<void> {
  try {
    await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

type MailpitList = { messages: Array<{ ID: string; To: Array<{ Address: string }> }> };
type MailpitMessage = { Text?: string; HTML?: string };

// Poll for the newest message addressed to `to` and return the first match of
// `pattern` in its text/HTML body.
async function waitForMatch(to: string, pattern: RegExp, label: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as MailpitList;
    const msg = list.messages?.find((m) => m.To?.some((t) => t.Address === to));
    if (msg) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json()) as MailpitMessage;
      const match = `${full.Text ?? ""} ${full.HTML ?? ""}`.match(pattern);
      if (match) return match[0];
    }
    await new Promise((r) => setTimeout(r, 300));
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
