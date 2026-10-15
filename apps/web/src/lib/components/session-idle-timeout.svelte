<script lang="ts">
  import { goto } from "$app/navigation";
  import { api } from "#lib/api.js";

  let { timeoutMinutes }: { timeoutMinutes: number | null } = $props();

  const ACTIVITY_KEY = "podokit:session-last-activity";
  const SERVER_REFRESH_INTERVAL_MS = 60_000;
  // Every localStorage write fires a `storage` event in each other open tab.
  const ACTIVITY_WRITE_INTERVAL_MS = 5_000;
  const activityEvents = ["pointerdown", "keydown", "touchstart", "scroll"] as const;

  let signingOut = false;
  const timeoutMs = $derived(timeoutMinutes === null ? null : timeoutMinutes * 60_000);

  function readStoredActivity(): number {
    try {
      const value = Number(localStorage.getItem(ACTIVITY_KEY));
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

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

  function trackActivity(limit: number): () => void {
    // The policy only exists for a signed-in user, so a new tracker means a new session.
    signingOut = false;
    let lastActivityAt = Date.now();
    let storedActivityAt = lastActivityAt;
    let lastWriteAt = lastActivityAt;
    let lastServerRefreshAt = lastActivityAt;
    let deadlineTimer: number | undefined;
    let flushTimer: number | undefined;
    storeActivity(lastActivityAt);

    function flush(): void {
      window.clearTimeout(flushTimer);
      flushTimer = undefined;
      if (signingOut || lastActivityAt <= storedActivityAt) return;
      storedActivityAt = lastActivityAt;
      lastWriteAt = Date.now();
      storeActivity(storedActivityAt);
    }

    function expire(): void {
      window.clearTimeout(deadlineTimer);
      window.clearTimeout(flushTimer);
      void signOutForIdleTimeout();
    }

    // The deadline is re-read when the timer fires rather than re-armed on every
    // event; other tabs' activity arrives through storage.
    function check(): void {
      if (signingOut) return;
      const latest = Math.max(lastActivityAt, readStoredActivity());
      const remaining = limit - (Date.now() - latest);
      if (remaining <= 0) return expire();
      window.clearTimeout(deadlineTimer);
      deadlineTimer = window.setTimeout(check, remaining);
    }

    function recordActivity(): void {
      if (signingOut) return;
      const now = Date.now();
      // Timers can be suspended (sleep, background throttling), so a late event may arrive past the deadline.
      if (now - lastActivityAt >= limit && now - readStoredActivity() >= limit) return expire();
      lastActivityAt = now;
      const sinceWrite = now - lastWriteAt;
      if (sinceWrite >= ACTIVITY_WRITE_INTERVAL_MS) flush();
      else flushTimer ??= window.setTimeout(flush, ACTIVITY_WRITE_INTERVAL_MS - sinceWrite);
      if (now - lastServerRefreshAt >= SERVER_REFRESH_INTERVAL_MS) {
        lastServerRefreshAt = now;
        void refreshServerSession();
      }
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === "hidden") flush();
      else check();
    }

    for (const event of activityEvents) {
      document.addEventListener(event, recordActivity, { passive: true, capture: true });
    }
    window.addEventListener("focus", recordActivity);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flush);
    deadlineTimer = window.setTimeout(check, limit);

    return () => {
      for (const event of activityEvents) {
        document.removeEventListener(event, recordActivity, { capture: true });
      }
      window.removeEventListener("focus", recordActivity);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flush);
      window.clearTimeout(deadlineTimer);
      window.clearTimeout(flushTimer);
    };
  }

  $effect(() => {
    if (timeoutMs === null) return;
    return trackActivity(timeoutMs);
  });
</script>
