# Bootstrap the initial administrator

Use the generated database-backed command after the API build and migrations.
With `NODE_ENV=production` it loads the bundled `dist/bootstrap-admin-runtime.js`;
otherwise it runs the source entry. It supports PostgreSQL and SQLite.
Do not create the first administrator through the public sign-up page.

## Set the persistent allowlist

Set `ADMIN_EMAILS` in the same deployment environment used by the API. Include
the exact lowercase-normalized address selected for the initial administrator.
Use the administrators' real addresses: with `NODE_ENV=production` the API
refuses to start when an entry is not an address or is on a reserved
documentation name such as `example.com`, and `podo deploy doctor` fails on it.

Keep this value after bootstrap. A later account with a listed address becomes
an administrator only when its address is proven as the account is created: by
`admin:bootstrap`, an administrator, a social provider that reports the email
verified, a magic link, or an email code. An email and password sign-up with a
listed address is refused, so nobody can claim it before its owner.

## Inject credentials for one command

Prefer the deployment secret manager or a hidden shell prompt. Do not put the
password in a command argument, repository file, image layer, CI log, or
long-lived Kubernetes Secret.

```bash
export ADMIN_BOOTSTRAP_EMAIL="admin@example.com"
printf "Initial admin password: " >&2
IFS= read -r -s ADMIN_BOOTSTRAP_PASSWORD
printf "\n" >&2
export ADMIN_BOOTSTRAP_PASSWORD
```

`AUTH_SETUP_ADMIN_EMAIL` and `AUTH_SETUP_ADMIN_PASSWORD` are accepted as
fallbacks so the same ephemeral values can immediately configure OAuth and SMTP.

## Preview, create, and verify

```bash
bun run --cwd apps/api admin:bootstrap -- --dry-run
bun run --cwd apps/api admin:bootstrap
bun run --cwd apps/api admin:bootstrap -- --check-only
```

The create path writes `role=admin`, `emailVerified=true`, and
`signupApproved=true`. A rerun never updates an existing row or resets a
password. It succeeds only when the account still has the admin role, verified
and approved flags, and the supplied password matches.

Unset the password immediately after `auth:configure` or the verification step:

```bash
unset ADMIN_BOOTSTRAP_PASSWORD AUTH_SETUP_ADMIN_PASSWORD
```

If the command reports an existing mismatched account, stop. Recover it through
an authenticated administrator or an audited operator procedure; do not delete,
promote, verify, or reset the row automatically.
