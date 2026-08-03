// Reactive site branding (name, favicon, …) shared between the layout (which
// applies the browser title/favicon) and the admin general-settings form (which
// updates it live). Initialised from the server load; patched after a save.
export interface SiteSettings {
  name: string | null;
  description: string | null;
  supportEmail: string | null;
  footerText: string | null;
  brandColor: string | null;
  themePreset: string | null;
  themeRadius: string | null;
  themeOverrides: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
  locale: string | null;
  timezone: string | null;
  maintenanceMode: string | null;
  allowSignup: string | null;
  hasFavicon: boolean;
  faviconVersion: string | null;
}

const empty: SiteSettings = {
  name: null,
  description: null,
  supportEmail: null,
  footerText: null,
  brandColor: null,
  themePreset: null,
  themeRadius: null,
  themeOverrides: null,
  termsUrl: null,
  privacyUrl: null,
  locale: null,
  timezone: null,
  maintenanceMode: null,
  allowSignup: null,
  hasFavicon: false,
  faviconVersion: null,
};

let current = $state<SiteSettings>({ ...empty });
let initialized = $state(false);

export const site = {
  get value(): SiteSettings {
    return current;
  },
  get initialized(): boolean {
    return initialized;
  },
  /** Seed from the server load (idempotent). */
  init(v: Partial<SiteSettings> | null | undefined): void {
    if (v) {
      current = { ...empty, ...v };
      initialized = true;
    }
  },
  /** Merge in changes so the layout re-applies title/favicon immediately. */
  patch(v: Partial<SiteSettings>): void {
    current = { ...current, ...v };
  },
};
