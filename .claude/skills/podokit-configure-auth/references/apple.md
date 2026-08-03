# Apple sign-in

Apple uses the same PodoKit provider pipeline and sign-up approval gate, but its credentials have a different lifecycle.

1. Create an App ID with Sign in with Apple enabled.
2. Create a Services ID for the web application and register the domain and callback `https://example.com/api/auth/callback/apple`.
3. Create a Sign in with Apple key and retain the Team ID, Key ID, Services ID, and downloaded private key in a secret manager.
4. Generate the OAuth client secret as a signed JWT. Apple client secrets expire, so automate rotation before expiry and reapply the new value with `auth:configure`.
5. Configure the provider with `--provider apple`; use the Services ID as `OAUTH_CLIENT_ID` and the signed JWT as `OAUTH_CLIENT_SECRET`.
6. Test first-time consent carefully because Apple may only provide the user's name on the first authorization.

Do not store the Apple private key or generated client secret in the repository.

Official references:

- https://developer.apple.com/help/account/configure-app-capabilities/configure-sign-in-with-apple-for-the-web/
- https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
- https://better-auth.com/docs/authentication/apple
