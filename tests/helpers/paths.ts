import type { Locator, Page } from "@playwright/test";
import { appPaths } from "./app-paths";

/**
 * The application screens managed specs visit. The defaults describe the
 * generated pages; `app-paths.ts`, which the application owns, overrides any
 * of them, so a managed spec never needs editing for an app's own screens.
 */
export interface AppPaths {
  /** The first screen a visitor opens. */
  home: string;
  /** Visible once the first screen has rendered. */
  homeReady: (page: Page) => Locator;
  /** Public pages search engines may index: they carry no `X-Robots-Tag`. */
  indexable: string[];
  /** A public page that renders the managed `SiteFooter`, or null when none does. */
  footer: string | null;
  /**
   * A page that renders the managed `LanguageSwitch`, `ThemeToggle`, and
   * `AccountMenu` for a signed-in user, or null when none does.
   */
  accountMenu: string | null;
}

const defaults: AppPaths = {
  home: "/",
  homeReady: (page) => page.getByRole("heading", { level: 1 }),
  indexable: ["/"],
  footer: "/login",
  accountMenu: "/",
};

export const paths: AppPaths = { ...defaults, ...appPaths };
