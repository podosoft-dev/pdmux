# Bootstrap the initial administrator

Use the generated database-backed command after the API build and migrations.
Do not create the first administrator through the public sign-up page.

## Set the persistent allowlist

Set `ADMIN_EMAILS` in the same deployment environment used by the API. Include
the exact lowercase-normalized address selected for the initial administrator.
Keep this value after bootstrap so future matching sign-ups retain the same role
policy.

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
npm run admin:bootstrap -w <app>-api -- --dry-run
npm run admin:bootstrap -w <app>-api
npm run admin:bootstrap -w <app>-api -- --check-only
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
