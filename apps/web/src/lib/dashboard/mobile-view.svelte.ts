/**
 * The active region on a narrow screen, wired to the browser's history.
 *
 * WHY HISTORY AT ALL: on Android the Back button (or the back gesture) is how people
 * leave a screen. With a bottom tab bar and no history entries, Back from the Git tab
 * leaves the app entirely — the user loses the page, and with it every terminal on it.
 * Pushing an entry per tab makes Back mean "the previous tab", which is what the gesture
 * means everywhere else on the phone. iOS gets the same behaviour from its edge swipe.
 *
 * WHY SHALLOW ROUTING AND NOT A QUERY PARAMETER: `(shell)/+layout.server.ts` reads `url`
 * (for the login redirect), so SvelteKit re-runs that loader whenever the URL changes —
 * every tab tap would refetch hosts, prefs and fleet settings and re-seed the shell.
 * `pushState` from `$app/navigation` changes history WITHOUT running loaders, which is
 * exactly what a view switch needs.
 *
 * The state lives on `ShellState.view`; history only mirrors it, so a browser that
 * restores an entry we did not write (a reload, a session restore) still lands on a
 * region that exists.
 */
import { pushState } from "$app/navigation";
import { page } from "$app/state";
import type { ShellState, ShellView } from "./shell-state.svelte";

const VIEWS: readonly ShellView[] = ["hosts", "terminal", "git", "page"];

/** History state we own. Anything else in `page.state` belongs to another feature. */
interface ViewState {
  pdmuxView?: ShellView;
}

function asView(value: unknown): ShellView | null {
  return typeof value === "string" && (VIEWS as readonly string[]).includes(value) ? (value as ShellView) : null;
}

/**
 * Select a view and record it, so Back returns to the one before it.
 *
 * `replaceState` for the first selection of a visit would swallow the user's way back to
 * wherever they came from, so every selection pushes — except re-selecting the view
 * already on screen, which must not stack duplicate entries under the Back button.
 */
export function selectView(shell: ShellState, next: ShellView): void {
  if (shell.view === next) return;
  shell.view = next;
  pushState("", { ...(page.state as ViewState), pdmuxView: next });
}

/**
 * Follow a history entry back into the shell's state.
 *
 * Call it from an effect that reads `page.state`: SvelteKit updates that on popstate, and
 * this is the half of the loop that turns a Back press into a visible tab change. An
 * entry without our key (the one the page was loaded with) means "the default", not
 * "no change" — otherwise Back off the first tab would leave the tab bar lying about
 * which region is on screen.
 */
export function syncViewFromHistory(shell: ShellState, state: unknown, fallback: ShellView = "terminal"): void {
  const next = asView((state as ViewState | null)?.pdmuxView) ?? fallback;
  if (shell.view !== next) shell.view = next;
}
