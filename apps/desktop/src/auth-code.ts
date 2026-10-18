/** The native callback includes the one-time identifier and its PKCE state. */
export function authorizationCode(input: unknown): string {
  if (typeof input !== "string" || input.length > 1024) throw new Error("Invalid authorization code");
  const value = decodeURIComponent(input.trim());
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > 512) throw new Error("Invalid authorization code");
  const payload: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!payload || typeof payload !== "object" || !("identifier" in payload) || !("state" in payload) ||
    typeof payload.identifier !== "string" || !/^[A-Za-z0-9]{32}$/.test(payload.identifier) ||
    typeof payload.state !== "string" || !/^[A-Za-z0-9]{16}$/.test(payload.state)) throw new Error("Invalid authorization code");
  return value;
}
