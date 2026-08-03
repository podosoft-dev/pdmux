// Read-back helper for the dev SMS sink (the "Mailpit for SMS"). The app posts
// outgoing SMS to the sink via SMS_WEBHOOK_URL; tests poll it here to obtain the
// delivered code, so the phone-number flow is verified for real (not just "sent").
const SINK = process.env.SMS_SINK_URL ?? "http://localhost:8095";

type SinkMessage = { to: string; body: string; receivedAt: string };

export async function smsSinkReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${SINK}/readyz`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function clearSms(): Promise<void> {
  await fetch(`${SINK}/messages`, { method: "DELETE" }).catch(() => undefined);
}

/** Poll the sink until an SMS to `to` arrives, then return the first 4–8 digit code. */
export async function waitForSmsOtp(to: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${SINK}/messages`).catch(() => null);
    if (res?.ok) {
      const messages = (await res.json()) as SinkMessage[];
      const match = messages.find((m) => m.to === to);
      const code = match?.body.match(/\b\d{4,8}\b/)?.[0];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No SMS OTP for ${to} within ${timeoutMs}ms`);
}
