import type { AppPaths } from "./paths";

/**
 * Where pdmux's screens differ from the generated ones, for the managed e2e
 * specs. PodoKit creates this file once and never overwrites it. `paths.ts`
 * documents each entry and its default.
 *
 * The first screen is the signed-in terminal workspace, whose toolbar replaces a
 * document heading. No page is indexable: "/" is in APP_NON_INDEXABLE_PATHS.
 * The workspace shell has its own user menu (`shell-user`, covered by
 * pdmux-account.ui.spec.ts) instead of PodoKit's AccountMenu, and renders the
 * managed ThemeToggle next to it, so the theme spec checks the toggle people
 * use on /account in the shell rather than the admin console's.
 */
export const appPaths: Partial<AppPaths> = {
  homeReady: (page) => page.getByTestId("dashboard-shell"),
  indexable: [],
  accountMenu: null,
  themeToggle: "/account",
};
