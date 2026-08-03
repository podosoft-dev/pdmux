#!/usr/bin/env node

const args = process.argv.slice(2);

function has(flag) {
  return args.includes(flag);
}

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  console.log(`Configure PodoKit authentication through the admin API.

Usage:
  npm run auth:configure -- --provider google --require-signup-approval
  npm run auth:configure -- --provider google --redirect-only
  npm run auth:configure -- --smtp
  npm run auth:configure -- --check-only --provider google

Required environment for writes:
  AUTH_SETUP_ORIGIN          Public app origin (or BETTER_AUTH_URL)
  AUTH_SETUP_ADMIN_EMAIL     Administrator email
  AUTH_SETUP_ADMIN_PASSWORD  Administrator password

OAuth environment:
  OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET
  OAUTH_REDIRECT_URI (optional)
  Provider-specific variables such as GOOGLE_CLIENT_ID also work.

SMTP environment (with --smtp):
  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM

Options:
  --provider <id>                 Configure a social provider
  --redirect-only                 Update only the provider callback; keep credentials and enabled state
  --smtp                          Configure SMTP from environment variables
  --require-signup-approval       Require admin approval for future registrations
  --no-require-signup-approval    Auto-approve future registrations
  --check-only                    Check public capabilities without writing
  --dry-run                       Print a redacted plan without writing
`);
}

function required(name, current) {
  if (!current) throw new Error(`${name} is required.`);
  return current;
}

function providerEnvName(provider, suffix) {
  return `${provider.toUpperCase().replaceAll("-", "_")}_${suffix}`;
}

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === "true";
}

function redactedPlan(body) {
  return {
    ...body,
    ...(body.social
      ? {
          social: Object.fromEntries(
            Object.entries(body.social).map(([id, provider]) => [
              id,
              { ...provider, clientSecret: provider.clientSecret ? "<redacted>" : undefined },
            ]),
          ),
        }
      : {}),
    ...(body.smtp
      ? { smtp: { ...body.smtp, pass: body.smtp.pass ? "<redacted>" : undefined } }
      : {}),
  };
}

function cookies(response) {
  const getSetCookie = response.headers.getSetCookie;
  const values = typeof getSetCookie === "function"
    ? getSetCookie.call(response.headers)
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map((item) => item.split(";", 1)[0]).join("; ");
}

async function signIn(origin, email, password) {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Administrator sign-in failed (${response.status}): ${text}`);
  }
  const cookie = cookies(response);
  if (!cookie) throw new Error("Administrator sign-in returned no session cookie.");
  return cookie;
}

async function publicCapabilities(origin) {
  const response = await fetch(`${origin}/api/account/capabilities`);
  if (!response.ok) throw new Error(`Capabilities check failed (${response.status}).`);
  return response.json();
}

async function main() {
  if (has("--help") || has("-h")) {
    usage();
    return;
  }

  const rawOrigin = process.env.AUTH_SETUP_ORIGIN ?? process.env.BETTER_AUTH_URL ?? "http://localhost:5002";
  const origin = new URL(rawOrigin).origin;
  const provider = value("--provider");
  const redirectOnly = has("--redirect-only");
  const configureSmtp = has("--smtp");
  const approval = has("--require-signup-approval")
    ? true
    : has("--no-require-signup-approval")
      ? false
      : undefined;

  if (provider && !/^[a-z0-9-]+$/.test(provider)) throw new Error("Provider id must use lowercase letters, numbers, or hyphens.");
  if (redirectOnly && !provider) throw new Error("--redirect-only requires --provider <id>.");

  const redirectURI = provider
    ? process.env.OAUTH_REDIRECT_URI ?? `${origin}/api/auth/callback/${provider}`
    : undefined;
  if (redirectURI) console.log(`OAuth callback URL: ${redirectURI}`);
  if (has("--check-only")) {
    const capabilities = await publicCapabilities(origin);
    console.log(JSON.stringify(capabilities, null, 2));
    if (provider && !capabilities.providers?.includes(provider)) {
      throw new Error(`Provider "${provider}" is not enabled.`);
    }
    return;
  }

  const body = {};
  if (provider) {
    if (redirectOnly) {
      body.social = { [provider]: { redirectURI } };
    } else {
      const clientId = process.env.OAUTH_CLIENT_ID ?? process.env[providerEnvName(provider, "CLIENT_ID")];
      const clientSecret = process.env.OAUTH_CLIENT_SECRET ?? process.env[providerEnvName(provider, "CLIENT_SECRET")];
      body.social = {
        [provider]: {
          enabled: true,
          clientId: required("OAUTH_CLIENT_ID", clientId),
          clientSecret: required("OAUTH_CLIENT_SECRET", clientSecret),
          redirectURI,
        },
      };
    }
  }
  if (configureSmtp) {
    body.smtp = {
      enabled: true,
      host: required("SMTP_HOST", process.env.SMTP_HOST),
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: bool(process.env.SMTP_SECURE),
      user: process.env.SMTP_USER ?? "",
      from: process.env.MAIL_FROM ?? "",
      ...(process.env.SMTP_PASS ? { pass: process.env.SMTP_PASS } : {}),
    };
  }
  if (approval !== undefined) body.server = { requireSignupApproval: approval };

  if (Object.keys(body).length === 0) throw new Error("Choose --provider, --smtp, or a sign-up approval option.");
  if (has("--dry-run")) {
    console.log(JSON.stringify(redactedPlan(body), null, 2));
    return;
  }

  const email = required("AUTH_SETUP_ADMIN_EMAIL", process.env.AUTH_SETUP_ADMIN_EMAIL);
  const password = required("AUTH_SETUP_ADMIN_PASSWORD", process.env.AUTH_SETUP_ADMIN_PASSWORD);
  const cookie = await signIn(origin, email, password);
  const response = await fetch(`${origin}/api/account/auth-config`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Authentication configuration failed (${response.status}): ${text}`);
  }
  console.log("Authentication configuration updated.");
  console.log(JSON.stringify(await publicCapabilities(origin), null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
