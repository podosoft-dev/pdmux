/**
 * Application-owned path prefixes whose responses carry
 * `X-Robots-Tag: noindex, nofollow`, in addition to the admin, account, sign-in,
 * and API paths PodoKit already lists in search-indexing.ts. A listed path also
 * covers its subpaths ("/app" covers "/app/projects/1"); "/" covers only the
 * landing page. PodoKit creates this file once and never overwrites it.
 */
// The landing page is the signed-in terminal workspace, not a public page.
export const APP_NON_INDEXABLE_PATHS: readonly string[] = ["/"];
