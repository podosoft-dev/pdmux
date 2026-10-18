import { APIError } from "better-auth/api";
import { PUBLIC_SIGNUP_DISABLED } from "./feature-gate";

// Domains reserved for documentation and testing (RFC 2606, RFC 6761). They
// receive no mail, so an address on one, such as admin@example.com, is a
// placeholder that nobody can prove.
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
const RESERVED_TOP_LEVEL = new Set(["example", "test", "invalid", "localhost"]);

/** Why an ADMIN_EMAILS entry cannot name a real administrator, or null when it can. */
export function adminEmailProblem(entry: string): string | null {
  const domain = entry.slice(entry.lastIndexOf("@") + 1);
  if (
    RESERVED_DOMAINS.some((name) => domain === name || domain.endsWith(`.${name}`)) ||
    RESERVED_TOP_LEVEL.has(domain.slice(domain.lastIndexOf(".") + 1))
  ) {
    return "a placeholder on a reserved domain";
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry) ? null : "not an email address";
}

/**
 * The administrator addresses in ADMIN_EMAILS, lowercased. In production an
 * entry that is not an address, or a placeholder such as admin@example.com,
 * stops the API: a placeholder means the administrators were never configured.
 */
export function adminEmailsFrom(
  value: string | undefined,
  production = process.env.NODE_ENV === "production",
): ReadonlySet<string> {
  const entries = (value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (production) {
    const problems = entries.flatMap((entry) => {
      const problem = adminEmailProblem(entry);
      return problem ? [`"${entry}" is ${problem}`] : [];
    });
    if (problems.length > 0) {
      throw new Error(
        `ADMIN_EMAILS must list real administrator addresses in production, or stay empty: ${problems.join("; ")}.`,
      );
    }
  }
  return new Set(entries);
}

/**
 * Whether a new account becomes an administrator through ADMIN_EMAILS. Only an
 * account that has proven its address does: one created with a verified email
 * (a social provider's verified address, a magic link or email code, or
 * admin:bootstrap) or one an administrator creates. Any other account with a
 * listed address is refused, so nobody can register an administrator's address
 * before its owner and take the role, the approval, or the address itself.
 */
export function becomesAdministrator(
  user: { email: string; emailVerified?: boolean | null },
  createdByAdmin: boolean,
  administrators: ReadonlySet<string>,
): boolean {
  if (!administrators.has(user.email.toLowerCase())) return false;
  if (user.emailVerified === true || createdByAdmin) return true;
  throw APIError.from("FORBIDDEN", {
    code: PUBLIC_SIGNUP_DISABLED,
    message: "This email address cannot be registered by sign-up.",
  });
}
