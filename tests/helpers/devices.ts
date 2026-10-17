const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

/** The `name=value` of the session cookie a sign-in response sets. */
function sessionCookie(response: Response): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const [pair = ""] = header.split(";");
    const name = pair.slice(0, pair.indexOf("="));
    // Better Auth names it `better-auth.session_token`, with a `__Secure-`
    // prefix on HTTPS; the multi-session plugin's cookies end in the token.
    if (name.endsWith("session_token")) return pair;
  }
  return undefined;
}

async function signIn(email: string, password: string, cookie?: string): Promise<Response> {
  return fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ email, password }),
  });
}

/**
 * Signs in `count` times, each as a separate device, and returns the response
 * statuses.
 *
 * Sign-ins are authentication writes. From an anonymous client the rate
 * limiter counts them against the per-address budget that every other spec's
 * sign-ins share, so a hundred of them refused unrelated sign-ins elsewhere in
 * the run. Only the first one is anonymous here; every later one carries the
 * first sign-in's session cookie, so the limiter counts it against that
 * session instead.
 *
 * A request carries that one cookie and nothing else: Better Auth's
 * multi-session plugin deletes a same-user session that a sign-in carries in
 * its multi-session cookies, so a client that kept every cookie would end with
 * one session instead of `count`.
 */
export async function signInOnSeparateDevices(email: string, password: string, count: number): Promise<number[]> {
  if (count < 1) return [];
  const first = await signIn(email, password);
  await first.body?.cancel();
  const statuses = [first.status];
  const cookie = sessionCookie(first);
  if (first.status !== 200 || !cookie) return statuses;
  for (let start = 1; start < count; start += 10) {
    const batch = Array.from({ length: Math.min(10, count - start) }, async () => {
      const response = await signIn(email, password, cookie);
      await response.body?.cancel();
      return response.status;
    });
    statuses.push(...(await Promise.all(batch)));
  }
  return statuses;
}
