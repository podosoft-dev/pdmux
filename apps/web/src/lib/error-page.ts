/**
 * The words of the error page, chosen by status.
 *
 * ⚠ THE SERVER'S MESSAGE IS NOT SHOWN AS THE SENTENCE. A guard throws `error(503, "Service
 * temporarily unavailable")`, and SvelteKit's default page printed that English line on a Korean
 * dashboard. The status picks a catalogue sentence instead.
 *
 * `messages` is optional because the page renders after a failure: when the root layout's data
 * did not arrive, there is no catalogue, and English is the only text available.
 */
import type { Messages } from "#lib/i18n/messages.js";

export interface ErrorPageText {
  title: string;
  message: string;
  status: string;
  retry: string;
  home: string;
}

const ENGLISH: Messages["errorPage"] = {
  title: "Something went wrong",
  unavailable: "The service is temporarily unavailable. Please try again in a moment.",
  notFound: "This page does not exist.",
  forbidden: "You do not have access to this page.",
  generic: "An unexpected error occurred.",
  status: "Error {status}",
  retry: "Try again",
  home: "Go to the dashboard",
};

export function errorPageText(status: number, messages: Messages | undefined): ErrorPageText {
  const words = messages?.errorPage ?? ENGLISH;
  const message =
    status === 404 ? words.notFound
      : status === 401 || status === 403 ? words.forbidden
        : status >= 502 && status <= 504 ? words.unavailable
          : words.generic;
  return {
    title: words.title,
    message,
    status: words.status.replace("{status}", String(status)),
    retry: words.retry,
    home: words.home,
  };
}
