import type { Locale } from "$lib/i18n/messages";
import type { SiteSettings } from "$lib/site.svelte";

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
  /**
   * Replaced at build time by Vite's `define` with the repo's SemVer. Read it through
   * `$lib/version.ts` rather than naming it directly — a bare identifier that only
   * exists after bundling is a confusing thing to meet in a component.
   */
  const __PDMUX_VERSION__: string;

  namespace App {
    interface Locals {
      user: SessionUser | null;
      session: { id: string; impersonatedBy?: string | null } | null;
      authUnavailable: boolean;
      locale: Locale;
      site: SiteSettings | null;
      siteUnavailable: boolean;
    }
  }
}

export {};
