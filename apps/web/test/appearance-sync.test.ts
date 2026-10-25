import { describe, expect, it } from "vitest";
import { type Appearance, AppearanceAgreement, parseAppearance } from "$lib/appearance-sync";

/** One page driven the way `appearance-sync.svelte` drives its agreement. */
class Page {
  readonly agreement = new AppearanceAgreement();
  constructor(public current: Appearance) {}

  poll(record: { value: Appearance | null }): void {
    this.current = { ...this.current, ...this.agreement.read(record.value, this.current) };
  }

  /** The write effect, after its delay; the server accepts. */
  flush(record: { value: Appearance | null }): void {
    const write = this.agreement.pending(this.current);
    if (!write) return;
    this.agreement.wrote(this.current, null);
    record.value = write;
    this.agreement.wrote(this.current, write);
  }
}

describe("[TC-PDWEB-052] devices sharing one appearance record do not flip each other", () => {
  it("adopts the record on the first read and a change made elsewhere, never a page's mere disagreement", () => {
    const record = { value: { theme: "dark", locale: "ko" } as Appearance | null };
    // A page rendered in English without anyone choosing it (no cookie, site settings unreachable).
    const stray = new Page({ theme: "dark", locale: "en" });
    const korean = new Page({ theme: "dark", locale: "ko" });
    for (let round = 0; round < 5; round += 1) {
      for (const page of [stray, korean]) { page.poll(record); page.flush(record); }
    }
    expect(record.value).toEqual({ theme: "dark", locale: "ko" });
    expect(korean.current.locale).toBe("ko");
    expect(stray.current.locale).toBe("ko");
  });

  it("writes nothing before its first read, and nothing when no record exists and nobody chose", () => {
    const record = { value: null as Appearance | null };
    const page = new Page({ theme: "dark", locale: "en" });
    page.flush(record);
    page.poll(record);
    page.flush(record);
    expect(record.value).toBeNull();
  });

  it("publishes only the field changed here, so a theme toggle does not publish this page's language", () => {
    const record = { value: { theme: "dark", locale: "ko" } as Appearance | null };
    const desktop = new Page({ theme: "dark", locale: "en" });
    desktop.agreement.read({ theme: "dark", locale: "ko" }, { theme: "dark", locale: "en" });
    // The page kept English (its locale was settled as-is), then the user toggled the theme.
    desktop.agreement.baseline = { theme: "dark", locale: "en" };
    desktop.current = { theme: "light", locale: "en" };
    desktop.flush(record);
    expect(record.value).toEqual({ theme: "light", locale: "ko" });
  });

  it("carries a language chosen on one device to another, once", () => {
    const record = { value: { theme: "system", locale: "ko" } as Appearance | null };
    const phone = new Page({ theme: "system", locale: "ko" });
    const laptop = new Page({ theme: "system", locale: "ko" });
    phone.poll(record); laptop.poll(record);
    laptop.current = { ...laptop.current, locale: "en" };
    // A poll lands between the choice and its write (the write waits 500ms): the record has not
    // changed since the laptop last saw it, so the choice stands and is still written.
    laptop.poll(record);
    expect(laptop.current.locale).toBe("en");
    laptop.flush(record);
    expect(record.value?.locale).toBe("en");
    phone.poll(record);
    expect(phone.current.locale).toBe("en");
    phone.current = { ...phone.current, locale: "ko" };
    phone.flush(record);
    laptop.poll(record);
    expect(laptop.current.locale).toBe("ko");
    const before = record.value;
    for (const page of [phone, laptop]) { page.poll(record); page.flush(record); }
    expect(record.value).toBe(before);
  });

  it("parses only a complete, known record", () => {
    expect(parseAppearance({ theme: "dark", locale: "ko" }, ["en", "ko"])).toEqual({ theme: "dark", locale: "ko" });
    expect(parseAppearance({ theme: "dark", locale: "fr" }, ["en", "ko"])).toBeNull();
    expect(parseAppearance({ theme: "neon", locale: "ko" }, ["en", "ko"])).toBeNull();
    expect(parseAppearance(null, ["en", "ko"])).toBeNull();
  });
});
