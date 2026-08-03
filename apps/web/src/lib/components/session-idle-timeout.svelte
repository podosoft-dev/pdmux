<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { api } from "$lib/api";

  let { timeoutMinutes }: { timeoutMinutes: number | null } = $props();

  const ACTIVITY_KEY = "podokit:session-last-activity";
  const SERVER_REFRESH_INTERVAL_MS = 60_000;
  const activityEvents = ["pointerdown", "keydown", "touchstart", "scroll"] as const;

  let mounted = $state(false);
  let lastActivityAt = $state(Date.now());
  let lastServerRefreshAt = $state(Date.now());
  let signingOut = false;
  let previousTimeoutMs: number | null = null;
  const timeoutMs = $derived(timeoutMinutes === null ? null : timeoutMinutes * 60_000);

  function storeActivity(value: number): void {
    try {
      localStorage.setItem(ACTIVITY_KEY, String(value));
    } catch {
      // Storage can be unavailable in hardened browser modes; this tab still works.
    }
  }

  async function signOutForIdleTimeout(): Promise<void> {
    if (signingOut) return;
    signingOut = true;
    try {
      await api.auth.signOut();
    } finally {
      try {
        localStorage.removeItem(ACTIVITY_KEY);
      } catch {
        // Ignore unavailable storage while completing sign-out.
      }
      await goto("/login?reason=idle", { invalidateAll: true });
    }
  }

  async function refreshServerSession(): Promise<void> {
    const { data, error } = await api.auth.getSession();
    if (error || !data) await signOutForIdleTimeout();
  }

  function recordActivity(): void {
    if (timeoutMs === null || signingOut) return;
    const now = Date.now();
    if (now - lastActivityAt >= timeoutMs) {
      void signOutForIdleTimeout();
      return;
    }
    lastActivityAt = now;
    storeActivity(now);
    if (now - lastServerRefreshAt >= SERVER_REFRESH_INTERVAL_MS) {
      lastServerRefreshAt = now;
      void refreshServerSession();
    }
  }

  function receiveActivity(event: StorageEvent): void {
    if (event.key !== ACTIVITY_KEY || event.newValue === null) return;
    const value = Number(event.newValue);
    if (Number.isFinite(value) && value > lastActivityAt) lastActivityAt = value;
  }

  onMount(() => {
    mounted = true;
    const now = Date.now();
    lastActivityAt = now;
    lastServerRefreshAt = now;
    storeActivity(now);
    for (const event of activityEvents) {
      document.addEventListener(event, recordActivity, { passive: true, capture: true });
    }
    window.addEventListener("focus", recordActivity);
    window.addEventListener("storage", receiveActivity);
    return () => {
      for (const event of activityEvents) {
        document.removeEventListener(event, recordActivity, { capture: true });
      }
      window.removeEventListener("focus", recordActivity);
      window.removeEventListener("storage", receiveActivity);
    };
  });

  $effect(() => {
    if (!mounted) return;
    const currentTimeoutMs = timeoutMs;
    if (currentTimeoutMs !== previousTimeoutMs) {
      previousTimeoutMs = currentTimeoutMs;
      if (currentTimeoutMs !== null) {
        const now = Date.now();
        lastActivityAt = now;
        lastServerRefreshAt = now;
        storeActivity(now);
      }
    }
    if (currentTimeoutMs === null) return;
    const remaining = currentTimeoutMs - (Date.now() - lastActivityAt);
    if (remaining <= 0) {
      void signOutForIdleTimeout();
      return;
    }
    const timer = window.setTimeout(() => void signOutForIdleTimeout(), remaining);
    return () => window.clearTimeout(timer);
  });
</script>
