import { page } from "$app/state";
import { site } from "$lib/site.svelte";
import { resolveLocale, type Locale, type Messages } from "./messages";

export type I18nContext = { readonly t: Messages; readonly locale: Locale };

interface I18nPageData {
  locale?: string;
  messages?: Messages;
}

function data(): I18nPageData {
  return page.data as I18nPageData;
}

export function getI18n(): I18nContext {
  return {
    get t() {
      const messages = data().messages;
      if (!messages) throw new Error("Locale messages were not loaded by the root layout");
      return messages;
    },
    get locale() {
      return resolveLocale(data().locale);
    },
  };
}

export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

export function formatDateTime(value: string | Date): string {
  const date = new Date(value);
  const timeZone = site.value.timezone || undefined;
  if (timeZone) {
    try {
      return date.toLocaleString(undefined, { timeZone });
    } catch {
      // Fall through to the browser timezone when an administrator entered an invalid value.
    }
  }
  return date.toLocaleString();
}
