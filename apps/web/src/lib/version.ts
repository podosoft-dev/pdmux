/**
 * pdmux's own SemVer, as shown in the account menu.
 *
 * The value is substituted by Vite's `define` from the ROOT package.json (see
 * vite.config.ts), so there is no second place to bump at release time and no
 * runtime fetch for something that cannot change while the tab is open.
 *
 * ⚠ THIS IS NOT THE AGENT'S VERSION. A host card's version badge compares the
 * agent's SemVer (`agent/internal/cli/version.go`, published in the release
 * manifest) against what that host reports. Showing this number there would mark
 * every host outdated the moment the web app alone is released — which is the whole
 * reason the two are separate.
 */
export const APP_VERSION: string = __PDMUX_VERSION__;
