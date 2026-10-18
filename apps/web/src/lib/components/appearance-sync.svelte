<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { invalidateAll } from "$app/navigation";
  import { setMode, userPrefersMode } from "mode-watcher";
  import { getI18n } from "#lib/i18n/index.js";
  const i18n = getI18n();
  let loaded = $state(false); let last = $state(""); let writing = false;
  const userId = $derived((page.data as { user?: { id?: string } }).user?.id);
  const theme = $derived(userPrefersMode.current ?? "system");
  async function persist(selected: "light" | "dark" | "system", locale: string): Promise<void> {
    if (writing) return;
    writing = true;
    const owner = userId;
    try {
      const response = await fetch("/api/desktop/appearance", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: selected, locale }) });
      if (response.ok && owner === userId) last = `${selected}:${locale}`;
    } finally { writing = false; }
  }
  async function refresh(): Promise<void> {
    if (writing) return;
    if (loaded && last !== `${theme}:${i18n.locale}`) { await persist(theme, i18n.locale); return; }
    const owner = userId;
    const response = await fetch("/api/desktop/appearance");
    if (!response.ok || owner !== userId) return;
    const value = await response.json() as { theme: "light" | "dark" | "system"; locale: string } | null;
    if (value && ["light", "dark", "system"].includes(value.theme) && ["en", "ko"].includes(value.locale)) {
      last = `${value.theme}:${value.locale}`;
      setMode(value.theme);
      if (value.locale !== i18n.locale) { document.cookie = `locale=${value.locale};path=/;max-age=31536000;samesite=lax`; await invalidateAll(); }
    }
    loaded = true;
  }
  $effect(() => {
    loaded = false; last = "";
    if (!userId) return;
    untrack(() => { void refresh().catch(() => undefined); });
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, 5_000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    const locale = i18n.locale; const selected = theme; const key = `${selected}:${locale}`;
    if (!userId || !loaded || last === key) return;
    const timer = setTimeout(() => {
      void persist(selected, locale).catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  });
</script>
