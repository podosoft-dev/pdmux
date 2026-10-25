import { describe, expect, it } from "vitest";
import { errorPageText } from "$lib/error-page";
import type { Messages } from "$lib/i18n/messages";
import english from "$lib/i18n/catalogs/app/en.json";
import korean from "$lib/i18n/catalogs/app/ko.json";

describe("[TC-PDWEB-053] the error page speaks the reader's language", () => {
  const ko = { ...english, ...korean } as unknown as Messages;

  it("chooses the sentence by status, never the server's English message", () => {
    expect(errorPageText(503, ko)).toMatchObject({ message: korean.errorPage.unavailable, status: "오류 503", retry: korean.errorPage.retry });
    expect(errorPageText(404, ko).message).toBe(korean.errorPage.notFound);
    expect(errorPageText(403, ko).message).toBe(korean.errorPage.forbidden);
    expect(errorPageText(500, ko).message).toBe(korean.errorPage.generic);
  });

  it("falls back to English when the catalogue never arrived", () => {
    expect(errorPageText(502, undefined)).toMatchObject({ message: english.errorPage.unavailable, status: "Error 502" });
  });
});
