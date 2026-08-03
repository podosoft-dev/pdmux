// Outgoing SMS transport. Point SMS_WEBHOOK_URL at your provider's HTTP API in
// production (or adapt this to a vendor SDK); in local dev it targets the SMS
// sink (docker-compose `dev` profile), which captures every message for tests to
// read back. With no SMS_WEBHOOK_URL set, fall back to logging so nothing crashes.
export type Sms = { to: string; body: string };

export async function sendSms(sms: Sms): Promise<void> {
  const url = process.env.SMS_WEBHOOK_URL;
  if (!url) {
    console.warn(`[sms] no SMS_WEBHOOK_URL configured; not delivered — to ${sms.to}: ${sms.body}`);
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sms),
    });
    if (!res.ok) console.warn(`[sms] delivery returned ${res.status} for ${sms.to}`);
  } catch (err) {
    console.warn(`[sms] delivery failed for ${sms.to}:`, err);
  }
}
