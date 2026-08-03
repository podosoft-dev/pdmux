#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

function has(flag) {
  return args.includes(flag);
}

function required(name, value) {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function usage() {
  console.log(`Create or verify the initial PodoKit administrator.

Usage:
  npm run admin:bootstrap -w <app>-api
  npm run admin:bootstrap -w <app>-api -- --dry-run
  npm run admin:bootstrap -w <app>-api -- --check-only

Required environment:
  ADMIN_EMAILS               Allowed administrator emails (comma-separated)
  ADMIN_BOOTSTRAP_EMAIL      Initial administrator email
  ADMIN_BOOTSTRAP_PASSWORD   Initial administrator password

Optional environment:
  ADMIN_BOOTSTRAP_NAME       Display name (default: Administrator)

AUTH_SETUP_ADMIN_EMAIL and AUTH_SETUP_ADMIN_PASSWORD work as fallbacks so the
same ephemeral credentials can be reused by auth:configure.

Options:
  --dry-run                  Validate and print a redacted plan without writing
  --check-only               Verify an existing administrator without creating
`);
}

export function resolveBootstrapInput(env = process.env) {
  const email = required(
    "ADMIN_BOOTSTRAP_EMAIL",
    env.ADMIN_BOOTSTRAP_EMAIL ?? env.AUTH_SETUP_ADMIN_EMAIL,
  ).toLowerCase();
  const password = required(
    "ADMIN_BOOTSTRAP_PASSWORD",
    env.ADMIN_BOOTSTRAP_PASSWORD ?? env.AUTH_SETUP_ADMIN_PASSWORD,
  );
  const name = required("ADMIN_BOOTSTRAP_NAME", env.ADMIN_BOOTSTRAP_NAME ?? "Administrator");
  const adminEmails = new Set(
    required("ADMIN_EMAILS", env.ADMIN_EMAILS)
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  if (!adminEmails.has(email)) {
    throw new Error("ADMIN_BOOTSTRAP_EMAIL must be listed in ADMIN_EMAILS.");
  }
  if (password.length < 8 || password.length > 128) {
    throw new Error("ADMIN_BOOTSTRAP_PASSWORD must be between 8 and 128 characters.");
  }

  return { email, password, name };
}

function roles(value) {
  return (value ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
}

async function verifyExisting(dependencies, input, user) {
  if (!roles(user.role).includes("admin")) {
    throw new Error("The administrator email already exists without the admin role; no changes were made.");
  }
  if (user.signupApproved !== true) {
    throw new Error("The administrator account is not approved; no changes were made.");
  }
  if (user.emailVerified !== true) {
    throw new Error("The administrator email is not verified; no changes were made.");
  }
  if (!user.passwordHash || !(await dependencies.verifyPassword(user.passwordHash, input.password))) {
    throw new Error("The administrator account already exists but the supplied password does not match; no changes were made.");
  }
}

export async function bootstrapAdmin(dependencies, input, options = {}) {
  const existing = await dependencies.findUser(input.email);

  if (options.dryRun) {
    return {
      status: "planned",
      action: existing ? "verify" : "create",
      email: input.email,
      name: input.name,
      password: "<redacted>",
    };
  }

  if (existing) {
    await verifyExisting(dependencies, input, existing);
    return { status: "existing", email: input.email };
  }

  if (options.checkOnly) {
    throw new Error("The administrator account does not exist; no changes were made.");
  }

  await dependencies.createUser({
    email: input.email,
    password: input.password,
    name: input.name,
    role: "admin",
    data: { emailVerified: true, signupApproved: true },
  });

  const created = await dependencies.findUser(input.email);
  if (!created) throw new Error("The administrator account was not found after creation.");
  await verifyExisting(dependencies, input, created);
  return { status: "created", email: input.email };
}

async function main() {
  if (has("--help") || has("-h")) {
    usage();
    return;
  }

  const input = resolveBootstrapInput();
  // Load the auth graph before importing one of its dependencies directly.
  // Concurrent ESM imports can ask Node to link the same Better Auth submodule
  // through two graph roots and fail before the command reaches the database.
  const { auth } = await import("../dist/auth/auth.js");
  const { pool } = await import("../dist/auth/db.js");
  const { verifyPassword } = await import("better-auth/crypto");

  try {
    const result = await bootstrapAdmin(
      {
        findUser: async (email) => {
          const query = await pool.query(
            `SELECT u.id,
                    u.email,
                    u.role,
                    u."emailVerified" AS "emailVerified",
                    u."signupApproved" AS "signupApproved",
                    a.password AS "passwordHash"
               FROM "user" AS u
          LEFT JOIN "account" AS a
                 ON a."userId" = u.id
                AND a."providerId" = 'credential'
              WHERE lower(u.email) = lower($1)
              LIMIT 1`,
            [email],
          );
          return query.rows[0] ?? null;
        },
        createUser: async (user) => auth.api.createUser({ body: user }),
        verifyPassword: async (hash, password) => verifyPassword({ hash, password }),
      },
      input,
      { dryRun: has("--dry-run"), checkOnly: has("--check-only") },
    );

    if (result.status === "planned") {
      console.log("Validated administrator bootstrap plan.");
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === "created") {
      console.log(`Created and verified administrator account ${result.email}.`);
    } else {
      console.log(`Verified existing administrator account ${result.email}.`);
    }
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
