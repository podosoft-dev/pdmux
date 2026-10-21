import type { Handle } from "@sveltejs/kit/hooks";

// The adapter emits this only after closing its listener and draining/aborting
// requests. The desktop web process owns no persistent state; remaining fetch
// handles must not keep app quit waiting for the supervisor's force-kill timer.
if (process.env.PDMUX_DESKTOP_RUNTIME === "1") {
  process.once("sveltekit:shutdown", () => process.exit(0));
}

/**
 * Application-owned request hook. The managed hooks.server.ts runs it for every
 * request after PodoKit has loaded the runtime context, so `event.locals` already
 * holds the site settings, the signed-in user, the session, and the locale. Change
 * `event.locals`, add response headers, or answer a request yourself here instead
 * of editing hooks.server.ts. Combine several handles with `sequence` from
 * "@sveltejs/kit/hooks". PodoKit creates this file once and never overwrites it.
 */
export const appHandle: Handle = ({ event, resolve }) => {
  if (event.locals.site && (!event.locals.site.name || event.locals.site.name === "pdmux")) event.locals.site.name = "PDMux";
  return resolve(event);
};
