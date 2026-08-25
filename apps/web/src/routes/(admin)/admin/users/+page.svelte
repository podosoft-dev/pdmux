<script lang="ts">
  import { goto } from "$app/navigation";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import DataTable, { type DataTableColumn, type SortState, DEFAULT_PAGE_SIZE } from "#lib/components/data-table.svelte";
  import TableToolbar, { type ToolbarFilter, type ToolbarSearchField } from "#lib/components/table-toolbar.svelte";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import { toast } from "svelte-sonner";
  import { api } from "#lib/api.js";
  import { getI18n, fmt, formatDateTime } from "#lib/i18n/index.js";
  import { cn } from "#lib/utils.js";
  import { deviceLabel } from "#lib/device-label.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const i18n = getI18n();
  const emailVerificationEnabled = $derived(data.capabilities.emailVerification);
  // Assignable roles come from the server (access-control); label the known ones.
  const roleNames = $derived(data.capabilities.roles ?? ["admin", "user"]);
  const roleLabel = (r: string): string =>
    ({ admin: i18n.t.users.roleAdmin, user: i18n.t.users.roleUser, moderator: i18n.t.users.roleModerator }) [r] ?? r;

  type Row = {
    id: string;
    name: string;
    email: string;
    role?: string | null;
    banned?: boolean | null;
    signupApproved?: boolean | null;
    emailVerified?: boolean | null;
    createdAt?: string | Date | null;
    banReason?: string | null;
    banExpires?: string | Date | null;
  };

  const PAGE_SIZE = DEFAULT_PAGE_SIZE;
  const LOAD_LIMIT = 500; // bounded client-side list; add server-side filtering for larger deployments
  let users = $state<Row[]>([]);
  let page = $state(1);
  let sort = $state<SortState | null>(null);
  let busy = $state(false);

  // Toolbar: filters + search both commit on the Search button (nothing applies
  // until then), so multiple filter/search conditions apply together.
  let search = $state("");
  let appliedSearch = $state("");
  let searchField = $state("email");
  let appliedSearchField = $state("email");
  let filterValues = $state<Record<string, string>>({ role: "", status: "" });
  let appliedFilters = $state<Record<string, string>>({ role: "", status: "" });

  const columns = $derived<DataTableColumn<Row>[]>([
    { key: "name", label: i18n.t.users.name, sortable: true },
    { key: "email", label: i18n.t.users.email, sortable: true },
    { key: "role", label: i18n.t.users.role, sortable: true, hideBelow: "md" },
    { key: "status", label: i18n.t.users.status, hideBelow: "lg" },
    {
      key: "createdAt",
      label: i18n.t.users.joined,
      sortable: true,
      hideBelow: "lg",
      value: (u) => (u.createdAt ? new Date(u.createdAt).getTime() : 0),
    },
    { key: "actions", label: "", class: "w-10" },
  ]);
  const filters = $derived<ToolbarFilter[]>([
    {
      key: "role",
      label: i18n.t.users.role,
      options: [{ value: "", label: i18n.t.toolbar.all }, ...roleNames.map((r) => ({ value: r, label: roleLabel(r) }))],
    },
    {
      key: "status",
      label: i18n.t.users.status,
      options: [
        { value: "", label: i18n.t.toolbar.all },
        { value: "active", label: i18n.t.users.active },
        { value: "pending", label: i18n.t.users.pendingApproval },
        { value: "banned", label: i18n.t.users.banned },
      ],
    },
  ]);
  const searchFields = $derived<ToolbarSearchField[]>([
    { value: "email", label: i18n.t.users.email },
    { value: "name", label: i18n.t.users.name },
  ]);

  const filtered = $derived(
    users.filter((u) => {
      if (appliedSearch) {
        const hay = (appliedSearchField === "name" ? u.name : u.email).toLowerCase();
        if (!hay.includes(appliedSearch.toLowerCase())) return false;
      }
      if (appliedFilters.role && (u.role ?? "user") !== appliedFilters.role) return false;
      if (appliedFilters.status === "banned" && !u.banned) return false;
      if (appliedFilters.status === "pending" && u.signupApproved !== false) return false;
      if (appliedFilters.status === "active" && (u.banned || u.signupApproved === false)) return false;
      return true;
    }),
  );

  async function load(): Promise<void> {
    const { data: res, error } = await api.auth.admin.listUsers({ query: { limit: LOAD_LIMIT } });
    if (error) return void toast.error(error.message ?? i18n.t.users.loadFailed);
    users = (res?.users ?? []) as Row[];
  }

  async function applySearch(): Promise<void> {
    await load(); // refresh from the server on explicit search, then filter client-side
    appliedSearch = search;
    appliedSearchField = searchField;
    appliedFilters = { ...filterValues };
    page = 1;
  }

  // Impersonate — become the user, then continue on the signed-in account page
  // where the banner offers a route back to the administrator session.
  async function impersonate(u: Row): Promise<void> {
    const { error } = await api.auth.admin.impersonateUser({ userId: u.id });
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    await goto("/account", { invalidateAll: true });
  }

  async function approve(u: Row): Promise<void> {
    busy = true;
    const { error } = await api.auth.admin.updateUser({
      userId: u.id,
      data: { signupApproved: true },
    });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    if (mUser?.id === u.id) mUser = { ...mUser, signupApproved: true };
    toast.success(i18n.t.users.approved);
    await load();
  }

  // Create user
  let createOpen = $state(false);
  let form = $state({ name: "", email: "", password: "", confirm: "", role: "user", sendVerify: true });
  let createError = $state("");
  async function createUser(event: Event): Promise<void> {
    event.preventDefault();
    if (form.password !== form.confirm) {
      createError = i18n.t.users.passwordMismatch;
      return;
    }
    createError = "";
    busy = true;
    const { error } = await api.auth.admin.createUser({
      name: form.name,
      email: form.email,
      password: form.password,
      // Roles are server-driven (capabilities.roles); the typed client only knows
      // the built-in ones, so assert at this boundary — the server validates it.
      role: form.role as "admin" | "user",
    });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    toast.success(i18n.t.users.userCreated);
    if (form.sendVerify && emailVerificationEnabled) {
      await api.auth.sendVerificationEmail({ email: form.email, callbackURL: `${location.origin}/admin` });
    }
    createOpen = false;
    form = { name: "", email: "", password: "", confirm: "", role: "user", sendVerify: true };
    page = 1;
    await load();
  }

  // Manage user — a two-pane modal mirroring the account settings, admin-scoped.
  type ManageSection = "profile" | "security" | "sessions" | "danger";
  type Session = { id: string; token: string; userAgent?: string | null; ipAddress?: string | null; createdAt: string | Date };
  let manageOpen = $state(false);
  let mUser = $state<Row | null>(null);
  let mSection = $state<ManageSection>("profile");
  const sections: ManageSection[] = ["profile", "security", "sessions", "danger"];
  // profile
  let mName = $state("");
  let mEmail = $state("");
  let mRole = $state("user");
  // security
  let mNewPassword = $state("");
  let mConfirmPassword = $state("");
  let mPwError = $state("");
  let mBanReason = $state("");
  let mBanDays = $state("");
  // sessions
  let mSessions = $state<Session[]>([]);
  let mSessionsPage = $state(1);
  let mSessionsSort = $state<SortState | null>(null);
  const mSessionsColumns: DataTableColumn<Session>[] = [
    { key: "userAgent", label: i18n.t.adminSessions.device, sortable: true, value: (s) => deviceLabel(s.userAgent) ?? s.userAgent ?? "" },
    { key: "ipAddress", label: i18n.t.adminSessions.ip, sortable: true },
    { key: "createdAt", label: i18n.t.adminSessions.since, sortable: true, value: (s) => new Date(s.createdAt).getTime() },
    { key: "actions", label: "", class: "w-10" },
  ];
  // danger
  let mDeleteArmed = $state(false);

  async function openManage(u: Row): Promise<void> {
    mUser = u;
    mSection = "profile";
    mName = u.name;
    mEmail = u.email;
    mRole = u.role ?? "user";
    mNewPassword = "";
    mConfirmPassword = "";
    mPwError = "";
    mBanReason = "";
    mBanDays = "";
    mDeleteArmed = false;
    mSessions = [];
    mSessionsPage = 1;
    manageOpen = true;
    await loadManagedSessions();
  }

  async function loadManagedSessions(): Promise<void> {
    if (!mUser) return;
    const { data: res } = await api.auth.admin.listUserSessions({ userId: mUser.id });
    mSessions = (res?.sessions ?? []) as Session[];
  }

  async function saveProfile(event: Event): Promise<void> {
    event.preventDefault();
    if (!mUser) return;
    busy = true;
    const nextRole = mRole;
    // Profile fields go through updateUser; role changes go through the dedicated
    // setRole endpoint (aligns with the admin plugin's access-control model).
    const { error } = await api.auth.admin.updateUser({
      userId: mUser.id,
      data: { name: mName, email: mEmail },
    });
    if (!error && nextRole !== (mUser.role ?? "user")) {
      // Custom roles are valid at runtime (server-enforced); assert past the
      // typed client, which only knows the built-in roles.
      const { error: roleError } = await api.auth.admin.setRole({ userId: mUser.id, role: nextRole as "admin" | "user" });
      if (roleError) {
        busy = false;
        return void toast.error(roleError.message ?? i18n.t.users.actionFailed);
      }
    }
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    mUser = { ...mUser, name: mName, email: mEmail, role: nextRole };
    toast.success(i18n.t.users.userUpdated);
    await load();
  }

  async function setPassword(event: Event): Promise<void> {
    event.preventDefault();
    if (!mUser) return;
    if (mNewPassword !== mConfirmPassword) {
      mPwError = i18n.t.users.passwordMismatch;
      return;
    }
    mPwError = "";
    busy = true;
    const { error } = await api.auth.admin.setUserPassword({ userId: mUser.id, newPassword: mNewPassword });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    mNewPassword = "";
    mConfirmPassword = "";
    toast.success(i18n.t.users.passwordSet);
  }

  async function resendVerification(): Promise<void> {
    if (!mUser) return;
    busy = true;
    const { error } = await api.auth.sendVerificationEmail({ email: mUser.email, callbackURL: `${location.origin}/admin` });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    toast.success(i18n.t.users.verificationSent);
  }

  async function markVerified(): Promise<void> {
    if (!mUser) return;
    busy = true;
    const { error } = await api.auth.admin.updateUser({ userId: mUser.id, data: { emailVerified: true } });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    mUser = { ...mUser, emailVerified: true };
    toast.success(i18n.t.users.markedVerified);
    await load();
  }

  async function sendResetEmail(): Promise<void> {
    if (!mUser) return;
    busy = true;
    const { error } = await api.auth.requestPasswordReset({ email: mUser.email, redirectTo: `${location.origin}/reset-password` });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    toast.success(i18n.t.users.resetEmailSent);
  }

  async function ban(event: Event): Promise<void> {
    event.preventDefault();
    if (!mUser) return;
    const days = Number(mBanDays);
    busy = true;
    const { error } = await api.auth.admin.banUser({
      userId: mUser.id,
      ...(mBanReason ? { banReason: mBanReason } : {}),
      ...(days > 0 ? { banExpiresIn: days * 24 * 60 * 60 } : {}),
    });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    mUser = { ...mUser, banned: true };
    toast.success(i18n.t.users.userBanned);
    await load();
  }

  async function unban(): Promise<void> {
    if (!mUser) return;
    busy = true;
    const { error } = await api.auth.admin.unbanUser({ userId: mUser.id });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    mUser = { ...mUser, banned: false };
    toast.success(i18n.t.users.userUnbanned);
    await load();
  }

  async function revokeSession(token: string): Promise<void> {
    busy = true;
    const { error } = await api.auth.admin.revokeUserSession({ sessionToken: token });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.adminSessions.loadFailed);
    toast.success(i18n.t.adminSessions.revoked);
    await loadManagedSessions();
  }

  async function revokeAllSessions(): Promise<void> {
    if (!mUser) return;
    busy = true;
    const { error } = await api.auth.admin.revokeUserSessions({ userId: mUser.id });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.adminSessions.loadFailed);
    toast.success(i18n.t.adminSessions.allRevoked);
    await loadManagedSessions();
  }

  async function deleteUser(): Promise<void> {
    if (!mUser) return;
    busy = true;
    const { error } = await api.auth.admin.removeUser({ userId: mUser.id });
    busy = false;
    if (error) return void toast.error(error.message ?? i18n.t.users.actionFailed);
    toast.success(i18n.t.users.userDeleted);
    manageOpen = false;
    await load();
  }

  $effect(() => {
    void load();
  });
</script>

<div class="flex flex-col gap-4">
  <div class="flex items-center justify-between gap-2">
    <h1 class="text-2xl font-semibold">{i18n.t.users.title}</h1>
    <Button onclick={() => { createError = ""; createOpen = true; }}><PlusIcon class="size-4" />{i18n.t.users.addUser}</Button>
  </div>
  <TableToolbar
    {filters}
    bind:filterValues
    {searchFields}
    bind:searchField
    bind:search
    filterHeading={i18n.t.toolbar.filter}
    searchHeading={i18n.t.toolbar.search}
    searchButton={i18n.t.toolbar.searchButton}
    onSearch={applySearch}
  />

  <DataTable
    {columns}
    rows={filtered}
    getKey={(u) => u.id}
    empty={i18n.t.users.empty}
    bind:sort
    bind:page
    perPage={PAGE_SIZE}
    ariaLabel={i18n.t.users.title}
    label={fmt(i18n.t.users.total, { count: filtered.length })}
  >
    {#snippet row(user, { cellClass })}
      <Table.Cell class={cn(cellClass("name"), "font-medium")}>{user.name}</Table.Cell>
      <Table.Cell class={cn(cellClass("email"), "text-muted-foreground")}>{user.email}</Table.Cell>
      <Table.Cell class={cellClass("role")}><Badge variant={user.role === "admin" ? "default" : "secondary"}>{user.role ?? "user"}</Badge></Table.Cell>
      <Table.Cell class={cellClass("status")}>
        <div class="flex flex-wrap gap-1">
          {#if user.signupApproved === false}
            <Badge variant="secondary">{i18n.t.users.pendingApproval}</Badge>
          {:else if user.banned}
            <Badge variant="destructive">{i18n.t.users.banned}</Badge>
          {:else}
            <Badge variant="outline">{i18n.t.users.active}</Badge>
          {/if}
          {#if emailVerificationEnabled}
            {#if user.emailVerified}<Badge variant="outline" class="text-green-600 dark:text-green-400">{i18n.t.users.verified}</Badge>{:else}<Badge variant="secondary">{i18n.t.users.unverified}</Badge>{/if}
          {/if}
        </div>
      </Table.Cell>
      <Table.Cell class={cn(cellClass("createdAt"), "text-muted-foreground")}>{user.createdAt ? formatDateTime(user.createdAt) : "—"}</Table.Cell>
      <Table.Cell class={cellClass("actions")}>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon"><EllipsisIcon class="size-4" /></Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            {#if user.signupApproved === false}
              <DropdownMenu.Item onSelect={() => approve(user)}>{i18n.t.users.approve}</DropdownMenu.Item>
            {/if}
            <DropdownMenu.Item onSelect={() => openManage(user)}>{i18n.t.users.manage}</DropdownMenu.Item>
            <DropdownMenu.Item disabled={user.id === data.currentUserId || user.signupApproved === false} onSelect={() => impersonate(user)}>
              {i18n.t.users.impersonate}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Table.Cell>
    {/snippet}
  </DataTable>
</div>

<!-- Create user -->
<Dialog.Root bind:open={createOpen}>
  <Dialog.Content>
    <Dialog.Header><Dialog.Title>{i18n.t.users.createTitle}</Dialog.Title></Dialog.Header>
    <form onsubmit={createUser} class="flex flex-col gap-3">
      <div class="flex flex-col gap-1"><Label for="c-name">{i18n.t.users.name}</Label><Input id="c-name" bind:value={form.name} required /></div>
      <div class="flex flex-col gap-1"><Label for="c-email">{i18n.t.users.email}</Label><Input id="c-email" type="email" bind:value={form.email} required /></div>
      <div class="flex flex-col gap-1"><Label for="c-password">{i18n.t.users.password}</Label><Input id="c-password" type="password" bind:value={form.password} required /></div>
      <div class="flex flex-col gap-1"><Label for="c-confirm">{i18n.t.users.confirmPassword}</Label><Input id="c-confirm" type="password" bind:value={form.confirm} required /></div>
      {#if createError}<p class="text-destructive text-sm">{createError}</p>{/if}
      <div class="flex flex-col gap-1">
        <Label for="c-role">{i18n.t.users.role}</Label>
        <Select.Root type="single" bind:value={form.role}>
          <Select.Trigger id="c-role" class="w-full">{roleLabel(form.role)}</Select.Trigger>
          <Select.Content>
            {#each roleNames as r (r)}<Select.Item value={r}>{roleLabel(r)}</Select.Item>{/each}
          </Select.Content>
        </Select.Root>
      </div>
      {#if emailVerificationEnabled}
        <Label class="flex items-center gap-2"><Checkbox bind:checked={form.sendVerify} />{i18n.t.users.sendVerificationOnCreate}</Label>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (createOpen = false)}>{i18n.t.users.cancel}</Button>
        <Button type="submit" disabled={busy}>{i18n.t.users.create}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<!-- Manage user (two-pane) -->
<Dialog.Root bind:open={manageOpen}>
  <Dialog.Content class="sm:max-w-3xl">
    <Dialog.Header><Dialog.Title class="truncate">{mUser?.email}</Dialog.Title></Dialog.Header>
    <div class="flex flex-col gap-4 sm:flex-row">
      <nav class="flex shrink-0 flex-wrap gap-1 sm:w-40 sm:flex-col">
        {#each sections as key (key)}
          <Button
            variant="ghost"
            onclick={() => (mSection = key)}
            aria-current={mSection === key ? "page" : undefined}
            class="h-auto justify-start px-3 py-2 text-sm font-medium {mSection === key ? 'bg-muted' : 'text-muted-foreground'}"
          >
            {i18n.t.account.nav[key]}
          </Button>
        {/each}
      </nav>

      <div class="h-[26rem] min-w-0 flex-1 overflow-y-auto">
        {#if mSection === "profile"}
          <form class="flex flex-col gap-3" onsubmit={saveProfile}>
            <div class="flex flex-col gap-1"><Label for="m-name">{i18n.t.users.name}</Label><Input id="m-name" bind:value={mName} required /></div>
            <div class="flex flex-col gap-1"><Label for="m-email">{i18n.t.users.email}</Label><Input id="m-email" type="email" bind:value={mEmail} required /></div>
            <div class="flex flex-col gap-1">
              <Label for="m-role">{i18n.t.users.role}</Label>
              <Select.Root type="single" bind:value={mRole}>
                <Select.Trigger id="m-role" class="w-full">{roleLabel(mRole)}</Select.Trigger>
                <Select.Content>
                  {#each roleNames as r (r)}<Select.Item value={r}>{roleLabel(r)}</Select.Item>{/each}
                </Select.Content>
              </Select.Root>
            </div>
            {#if mUser?.banned}<Badge variant="destructive" class="w-fit">{i18n.t.users.banned}</Badge>{/if}
            {#if mUser?.signupApproved === false}
              <div class="flex items-center gap-2">
                <Badge variant="secondary">{i18n.t.users.pendingApproval}</Badge>
                <Button type="button" variant="outline" size="sm" disabled={busy} onclick={() => { if (mUser) void approve(mUser); }}>
                  {i18n.t.users.approve}
                </Button>
              </div>
            {/if}
            {#if emailVerificationEnabled}
              <div class="flex items-center gap-2">
                {#if mUser?.emailVerified}<Badge variant="outline" class="text-green-600 dark:text-green-400">{i18n.t.users.verified}</Badge>
                {:else}
                  <Badge variant="secondary">{i18n.t.users.unverified}</Badge>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onclick={resendVerification}>{i18n.t.users.sendVerification}</Button>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onclick={markVerified}>{i18n.t.users.markVerified}</Button>
                {/if}
              </div>
            {/if}
            <Button type="submit" class="w-fit" disabled={busy}>{i18n.t.users.save}</Button>
          </form>
        {:else if mSection === "security"}
          <div class="flex flex-col gap-6">
            <form class="flex flex-col gap-3" onsubmit={setPassword}>
              <div class="flex flex-col gap-1"><Label for="m-pw">{i18n.t.users.newPassword}</Label><Input id="m-pw" type="password" bind:value={mNewPassword} required /></div>
              <div class="flex flex-col gap-1"><Label for="m-pw2">{i18n.t.users.confirmNewPassword}</Label><Input id="m-pw2" type="password" bind:value={mConfirmPassword} required /></div>
              {#if mPwError}<p class="text-destructive text-sm">{mPwError}</p>{/if}
              <Button type="submit" class="w-fit" disabled={busy}>{i18n.t.users.setPassword}</Button>
            </form>
            <div class="border-t pt-4">
              <Button type="button" variant="outline" disabled={busy} onclick={sendResetEmail}>{i18n.t.users.sendResetEmail}</Button>
            </div>
            <div class="border-t pt-4">
              {#if mUser?.banned}
                <div class="mb-3 flex flex-col gap-1 text-sm">
                  {#if mUser.banReason}<p><span class="text-muted-foreground">{i18n.t.users.banReason}:</span> {mUser.banReason}</p>{/if}
                  {#if mUser.banExpires}<p><span class="text-muted-foreground">{i18n.t.users.banExpiry}:</span> {formatDateTime(mUser.banExpires)}</p>{:else}<p class="text-muted-foreground">{i18n.t.users.banPermanent}</p>{/if}
                </div>
                <Button variant="outline" disabled={busy} onclick={unban}>{i18n.t.users.unban}</Button>
              {:else}
                <form class="flex flex-col gap-3" onsubmit={ban}>
                  <div class="flex flex-col gap-1"><Label for="m-reason">{i18n.t.users.banReason}</Label><Input id="m-reason" bind:value={mBanReason} /></div>
                  <div class="flex flex-col gap-1"><Label for="m-days">{i18n.t.users.banExpiryDays}</Label><Input id="m-days" type="number" min="0" bind:value={mBanDays} /></div>
                  <Button type="submit" variant="destructive" class="w-fit" disabled={busy}>{i18n.t.users.ban}</Button>
                </form>
              {/if}
            </div>
          </div>
        {:else if mSection === "sessions"}
          <div class="flex flex-col gap-3">
            <div class="flex justify-end">
              <Button variant="outline" size="sm" disabled={busy || mSessions.length === 0} onclick={revokeAllSessions}>{i18n.t.adminSessions.revokeAll}</Button>
            </div>
            <DataTable
              columns={mSessionsColumns}
              rows={mSessions}
              getKey={(s) => s.id}
              bind:sort={mSessionsSort}
              bind:page={mSessionsPage}
              perPage={PAGE_SIZE}
              label={fmt(i18n.t.adminSessions.total, { count: mSessions.length })}
              empty={i18n.t.adminSessions.empty}
            >
              {#snippet row(s)}
                <Table.Cell class="max-w-40 truncate" title={s.userAgent ?? ""}>{deviceLabel(s.userAgent) ?? s.userAgent ?? i18n.t.adminSessions.unknown}</Table.Cell>
                <Table.Cell class="text-muted-foreground">{s.ipAddress ?? "—"}</Table.Cell>
                <Table.Cell class="text-muted-foreground">{formatDateTime(s.createdAt)}</Table.Cell>
                <Table.Cell><Button variant="ghost" size="sm" disabled={busy} onclick={() => revokeSession(s.token)}>{i18n.t.users.revokeSession}</Button></Table.Cell>
              {/snippet}
            </DataTable>
          </div>
        {:else if mSection === "danger"}
          <div class="border-destructive/50 flex flex-col gap-3 rounded-md border p-4">
            <p class="text-muted-foreground text-sm">{fmt(i18n.t.users.deleteConfirm, { email: mUser?.email ?? "" })}</p>
            {#if mDeleteArmed}
              <div class="flex gap-2">
                <Button variant="outline" onclick={() => (mDeleteArmed = false)}>{i18n.t.users.cancel}</Button>
                <Button variant="destructive" disabled={busy} onclick={deleteUser}>{i18n.t.users.delete}</Button>
              </div>
            {:else}
              <Button
                variant="destructive"
                class="w-fit"
                disabled={mUser?.id === data.currentUserId}
                onclick={() => (mDeleteArmed = true)}
              >
                {i18n.t.users.delete}
              </Button>
            {/if}
          </div>
        {/if}
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (manageOpen = false)}>{i18n.t.users.close}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
