import type { BetterAuthOptions } from "better-auth";
import { DESKTOP_SCHEME } from "@pdmux/desktop-protocol";

/** Extend assembled authentication outside PodoKit's generated option fences. */
export function desktopAuthOptions<T extends BetterAuthOptions>(options: T): T {
  const original = options.trustedOrigins;
  options.trustedOrigins = async request => {
    const origins = typeof original === "function" ? await original(request) : original ?? [];
    return [...origins, `${DESKTOP_SCHEME}:/`];
  };
  return options;
}
