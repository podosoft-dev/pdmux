// The OAuth provider's consent endpoint verifies a signed copy of the authorization
// request sent in the body. Like Better Auth's own client plugin, forward only the
// parameters the server signed, so extra page parameters cannot break the signature.
export function signedOAuthQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has("sig")) return undefined;
  const signedNames = params.getAll("ba_param");
  if (signedNames.length === 0) return params.toString();
  const allowed = new Set(signedNames);
  const signed = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key === "sig" || key === "ba_param" || allowed.has(key)) signed.append(key, value);
  }
  return signed.toString();
}
