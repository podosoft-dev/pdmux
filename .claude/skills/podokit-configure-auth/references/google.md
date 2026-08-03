# Google sign-in

Use a Google Cloud project owned by the organization, not a personal project.

1. Configure the Google Auth Platform brand, support email, developer contact, privacy policy, and terms links.
2. Choose **External** when every Google account may sign in. Publish the app to **Production** after testing; test mode restricts users and refresh-token lifetime.
3. Create a **Web application** OAuth client.
4. Add the web origin, for example `https://example.com`, to authorized JavaScript origins.
5. Add the exact callback `https://example.com/api/auth/callback/google` to authorized redirect URIs.
6. Supply the client ID and secret to `auth:configure`; never commit either value.
7. Request only the scopes the application uses. Basic sign-in normally needs OpenID, email, and profile.

Google may require verification for an External production app, especially when sensitive scopes or branding are involved. Keep the homepage, privacy policy, terms, and verified domain consistent with the OAuth consent screen.

## Development

Keep normal development on the portless `*.localhost` origin provided by `podo dev`.
For an actual OAuth round trip, expose the web container through a stable HTTPS
development hostname using a Cloudflare Named Tunnel, a reserved ngrok domain, or a
preview deployment. Use a separate Google Cloud project and Web client for development.

1. Add `https://app-dev.example.com` as an authorized JavaScript origin.
2. Add `https://app-dev.example.com/api/auth/callback/google` as the exact redirect URI.
3. Include both `http://app.localhost` and `https://app-dev.example.com` in
   `CORS_ORIGIN`. Use the HTTPS origin as `BETTER_AUTH_URL` for the tunnel profile.
4. Open Admin Settings through the HTTPS origin before saving Google. The displayed
   callback is persisted. With the CLI, `AUTH_SETUP_ORIGIN` derives and persists the
   same callback; set `OAUTH_REDIRECT_URI` only for an explicit override. Configure
   without putting the secret on the command line:

   ```bash
   export AUTH_SETUP_ORIGIN="https://app-dev.example.com"
   export AUTH_SETUP_ADMIN_EMAIL="admin@example.com"
   export AUTH_SETUP_ADMIN_PASSWORD="<from-secret-manager>"
   export OAUTH_CLIENT_ID="<google-client-id>"
   export OAUTH_CLIENT_SECRET="<from-secret-manager>"
   npm run auth:configure -w <app>-api -- --provider google --dry-run
   npm run auth:configure -w <app>-api -- --provider google
   ```

   If only an existing callback is stale, keep the stored client ID, client
   secret, and enabled state:

   ```bash
   AUTH_SETUP_ORIGIN=https://app-dev.example.com \
     npm run auth:configure -w <app>-api -- --provider google --redirect-only
   ```

5. Start and finish Google sign-in through the HTTPS origin. Do not mix it with
   `app.localhost`; OAuth state cookies are scoped to the origin that created them.

Protect development content with the tunnel provider's access control, but bypass
the exact `/api/auth/callback/*` path so Google can reach it. Quick tunnels with a
changing hostname are unsuitable for a registered callback. See the PodoKit
`docs/oauth-development.md` guide for the provider-neutral boundary.

Official references:

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/protocols/oauth2/policies
- https://support.google.com/cloud/answer/15549257
- https://better-auth.com/docs/authentication/google
- https://better-auth.com/docs/plugins/oauth-proxy
