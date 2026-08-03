import { URI, type TOTP } from "otpauth";

/** Compute the current 6-digit code from an otpauth:// URI (the `totpURI` that
 *  two-factor/enable returns), the same way an authenticator app would. Lets
 *  tests complete the real 2FA verification flow. */
export function totpCode(otpauthUri: string): string {
  const totp = URI.parse(otpauthUri) as TOTP;
  return totp.generate();
}
