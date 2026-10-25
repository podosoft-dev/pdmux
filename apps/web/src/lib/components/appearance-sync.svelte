<script lang="ts">
  /**
   * Keeps this page's theme and language in step with the user's shared appearance record.
   * The rules — and the device-to-device flip they prevent — are in `#lib/appearance-sync.ts`.
   */
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { invalidateAll } from "$app/navigation";
  import { setMode, userPrefersMode } from "mode-watcher";
  import { getI18n } from "#lib/i18n/index.js";
  import { type Appearance, AppearanceAgreement, parseAppearance } from "#lib/appearance-sync.js";

  const LOCALES = ["en", "ko"] as const;
  const i18n = getI18n();
  const userId = $derived((page.data as { user?: { id?: string } }).user?.id);
  const current = $derived<Appearance>({ theme: userPrefersMode.current ?? "system", locale: i18n.locale });
  const agreement = new AppearanceAgreement();
  /** Bumped when the agreement settles, so the write effect looks again. */
  let settled = $state(0);
  let writing = false;

  async function persist(value: Appearance): Promise<void> {
    writing = true;
    const owner = userId;
    agreement.wrote(current, null);
    try {
      const response = await fetch("/api/desktop/appearance", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
      if (response.ok && owner === userId) agreement.wrote(current, value);
    } finally { writing = false; }
  }

  async function refresh(): Promise<void> {
    if (writing) return;
    const owner = userId;
    const response = await fetch("/api/desktop/appearance");
    if (!response.ok || owner !== userId || writing) return;
    const changes = agreement.read(parseAppearance(await response.json(), LOCALES), current);
    settled += 1;
    if (changes.theme) setMode(changes.theme);
    if (changes.locale) { document.cookie = `locale=${changes.locale};path=/;max-age=31536000;samesite=lax`; await invalidateAll(); }
  }

  $effect(() => {
    agreement.reset();
    if (!userId) return;
    untrack(() => { void refresh().catch(() => undefined); });
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, 5_000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    void settled;
    const now = current;
    if (!userId) return;
    const write = untrack(() => agreement.pending(now));
    if (!write) return;
    const timer = setTimeout(() => { void persist(write).catch(() => undefined); }, 500);
    return () => clearTimeout(timer);
  });
</script>
