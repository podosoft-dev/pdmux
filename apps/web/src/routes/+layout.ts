import { loadMessages } from "#lib/i18n/messages.js";
import type { LayoutLoad } from "./$types";

// Runs on the server for the first render and in the browser afterwards, so the
// catalogs never travel in `__data.json`. loadMessages() reuses one merged
// object per locale pair; the language switch changes `data.locale`.
export const load: LayoutLoad = async ({ data }) => ({
  ...data,
  messages: await loadMessages(data.locale, data.site?.locale),
});
