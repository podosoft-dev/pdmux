/**
 * Application-owned public page prefixes. A listed path also covers its
 * subpaths ("/pricing" covers "/pricing/teams"). These pages render for
 * anonymous visitors and keep rendering when the API or site settings are
 * unavailable; every other page requires a session and fails closed with 503
 * during an outage. Modules add their own prefixes in guards.ts, so do not
 * repeat them here. PodoKit creates this file once and never overwrites it.
 */
export const APP_PUBLIC_PATHS: readonly string[] = [
  // The one-line agent installer is fetched by `curl` on a host, which has no
  // session; the enrollment code it carries is what authorizes the host.
  "/install.sh",
];
