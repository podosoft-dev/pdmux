# SMTP delivery

Prefer an organizational SMTP relay over a personal mailbox password.

For Google Workspace SMTP relay:

1. Add an SMTP relay rule in the Google Admin console.
2. Restrict relay access to the production server's static public IP where possible.
3. Restrict allowed senders to addresses in the organization's domains.
4. Use `smtp-relay.gmail.com` on port 587 with STARTTLS (`SMTP_SECURE=false` in Nodemailer-style configuration), and require TLS in the Google Workspace relay policy.
5. Leave `SMTP_USER` and `SMTP_PASS` empty for an IP-authorized relay.
6. Set `MAIL_FROM` to an approved organizational sender.
7. Publish SPF, enable Google DKIM signing, and publish DMARC. Start DMARC conservatively, review reports, then strengthen enforcement.
8. Send a verification or password-reset message and inspect authentication results at the recipient.

App passwords are a fallback only. They require two-step verification and may be unavailable under organization policies or Advanced Protection.

Official references:

- https://support.google.com/a/answer/2956491
- https://support.google.com/a/answer/176600
- https://support.google.com/accounts/answer/185833
