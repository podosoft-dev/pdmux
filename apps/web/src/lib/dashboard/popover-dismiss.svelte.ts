/**
 * Dismiss an anchored popover on an outside click or Escape.
 *
 * ⚠ THE LISTENER IS ARMED ONE TASK LATE, on purpose. Registering it synchronously
 * lets the very click that opened the popover close it again: the trigger lives
 * outside the popover, so by the time the event bubbles to the document the popover
 * counts as open and the click counts as outside.
 *
 * It lives here because the shell has two of these on two different levels — the card
 * settings popover belongs to the sidebar (the layout) and the terminal target picker
 * to the dashboard page — and the timing above is not something to re-derive twice.
 */
export function dismissOnOutside(isOpen: () => boolean, close: () => void): void {
  $effect(() => {
    if (!isOpen()) return;
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    const armed = setTimeout(() => document.addEventListener("click", close), 0);
    document.addEventListener("keydown", onKeydown);
    return () => {
      clearTimeout(armed);
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKeydown);
    };
  });
}
