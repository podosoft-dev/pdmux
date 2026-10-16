import type { Capabilities } from "@podosoft/podokit-api-client";
import type { Locale } from "#lib/i18n/messages.js";
import type { SiteSettings } from "#lib/site.svelte.js";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  image?: string | null;
  emailVerified?: boolean;
  signupApproved?: boolean | null;
  twoFactorEnabled?: boolean | null;
  username?: string | null;
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean | null;
};

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null;
      session: { id: string; impersonatedBy?: string | null } | null;
      authUnavailable: boolean;
      locale: Locale;
      site: SiteSettings | null;
      siteUnavailable: boolean;
      /** Per-request memo; read it through `getCapabilities()` from `#lib/server/capabilities.js`. */
      capabilities?: Promise<Capabilities>;
    }
  }
}

export {};
