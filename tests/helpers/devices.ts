const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";

/**
 * Signs in `count` times, each as a separate device, and returns the response
 * statuses. Each request carries no cookies: a Playwright request context keeps
 * the cookies of its earlier sign-ins, and Better Auth's multi-session plugin
 * deletes a same-user session that a sign-in request carries, so signing in
 * again from one context leaves one session instead of adding one.
 */
export async function signInOnSeparateDevices(email: string, password: string, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let start = 0; start < count; start += 10) {
    const batch = Array.from({ length: Math.min(10, count - start) }, async () => {
      const response = await fetch(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      await response.body?.cancel();
      return response.status;
    });
    statuses.push(...(await Promise.all(batch)));
  }
  return statuses;
}
