// Display names of the social sign-in providers Better Auth reports in
// capabilities.providers. Unknown providers fall back to a capitalized id.
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  github: "GitHub",
  google: "Google",
  apple: "Apple",
  microsoft: "Microsoft",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** "Google" or "Google, GitHub": the providers a user can sign in with. */
export function providerList(providers: readonly string[]): string {
  return providers.map(providerLabel).join(", ");
}
