<script lang="ts">
  import { untrack } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Table from "#lib/components/ui/table/index.js";
  import * as Dialog from "#lib/components/ui/dialog/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import DataTable, { type DataTableColumn, type SortState } from "#lib/components/data-table.svelte";
  import { toast } from "svelte-sonner";
  import { api } from "#lib/api.js";
  import { getI18n, fmt, formatDateTime } from "#lib/i18n/index.js";

  /** Team management for one organization: list, create, rename, and delete
   *  teams, and add or remove team members from the organization's members.
   *  Render it only while the `teams` capability is on. */
  let {
    open = $bindable(false),
    organization,
  }: { open?: boolean; organization: { id: string; name: string } | null } = $props();

  const i18n = getI18n();
  const PER_PAGE = 8;

  type Team = { id: string; name: string; organizationId: string; createdAt: string | Date };
  type OrgMember = { id: string; userId: string; role: string; user: { name: string; email: string } };
  type TeamMember = { id: string; teamId: string; userId: string; name: string; email: string; createdAt: string | Date | null };

  let teams = $state<Team[]>([]);
  let orgMembers = $state<OrgMember[]>([]);
  let teamSort = $state<SortState | null>({ key: "name", dir: "asc" });
  let teamPage = $state(1);
  let newTeamName = $state("");
  let busy = $state(false);

  // The team whose members are shown; null shows the team list.
  let current = $state<Team | null>(null);
  let teamMembers = $state<TeamMember[]>([]);
  let memberSort = $state<SortState | null>({ key: "email", dir: "asc" });
  let memberPage = $state(1);
  let pickUserId = $state("");

  let renameOpen = $state(false);
  let renameTarget = $state<Team | null>(null);
  let renameValue = $state("");

  const teamColumns = $derived<DataTableColumn<Team>[]>([
    { key: "name", label: i18n.t.organizations.teamName, sortable: true },
    { key: "createdAt", label: i18n.t.organizations.created, sortable: true, hideBelow: "sm" },
    { key: "actions", label: "", class: "w-10" },
  ]);
  const memberColumns = $derived<DataTableColumn<TeamMember>[]>([
    { key: "name", label: i18n.t.organizations.name, sortable: true },
    { key: "email", label: i18n.t.organizations.email, sortable: true, hideBelow: "sm" },
    { key: "actions", label: "", class: "w-10" },
  ]);

  // Organization members who are not in the shown team yet.
  const candidates = $derived(orgMembers.filter((m) => !teamMembers.some((t) => t.userId === m.userId)));
  const pickLabel = (userId: string): string => {
    const member = orgMembers.find((m) => m.userId === userId);
    return member ? member.user.name || member.user.email : i18n.t.organizations.pickMember;
  };

  const failed = (message?: string): void => void toast.error(message ?? i18n.t.organizations.actionFailed);

  async function loadTeams(organizationId: string): Promise<void> {
    const { data, error } = await api.auth.organization.listTeams({ query: { organizationId } });
    if (error) return failed(error.message);
    teams = (data ?? []) as Team[];
  }
  async function loadOrgMembers(organizationId: string): Promise<void> {
    const { data } = await api.auth.organization.getFullOrganization({ query: { organizationId } });
    orgMembers = ((data as { members?: OrgMember[] } | null)?.members ?? []) as OrgMember[];
  }
  async function loadTeamMembers(team: Team): Promise<void> {
    try {
      const query = new URLSearchParams({ organizationId: team.organizationId, teamId: team.id });
      teamMembers = await api.get<TeamMember[]>(`/account/team-members?${query}`);
    } catch {
      failed();
    }
  }

  $effect(() => {
    const id = open ? organization?.id : undefined;
    if (!id) return;
    untrack(() => {
      current = null;
      teams = [];
      teamMembers = [];
      newTeamName = "";
      void loadTeams(id);
      void loadOrgMembers(id);
    });
  });

  async function createTeam(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!organization) return;
    busy = true;
    const { error } = await api.auth.organization.createTeam({ name: newTeamName.trim(), organizationId: organization.id });
    busy = false;
    if (error) return failed(error.message);
    toast.success(i18n.t.organizations.teamCreated);
    newTeamName = "";
    await loadTeams(organization.id);
  }

  function startRename(team: Team): void {
    renameTarget = team;
    renameValue = team.name;
    renameOpen = true;
  }
  async function saveRename(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!renameTarget) return;
    busy = true;
    const { error } = await api.auth.organization.updateTeam({
      teamId: renameTarget.id,
      data: { name: renameValue.trim(), organizationId: renameTarget.organizationId },
    });
    busy = false;
    if (error) return failed(error.message);
    toast.success(i18n.t.organizations.teamRenamed);
    renameOpen = false;
    await loadTeams(renameTarget.organizationId);
  }

  async function deleteTeam(team: Team): Promise<void> {
    busy = true;
    const { error } = await api.auth.organization.removeTeam({ teamId: team.id, organizationId: team.organizationId });
    busy = false;
    if (error) return failed(error.message);
    toast.success(i18n.t.organizations.teamDeleted);
    await loadTeams(team.organizationId);
  }

  async function showMembers(team: Team): Promise<void> {
    current = team;
    teamMembers = [];
    pickUserId = "";
    memberPage = 1;
    await loadTeamMembers(team);
  }

  async function addMember(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!current || !pickUserId) return;
    busy = true;
    const { error } = await api.auth.organization.addTeamMember({
      teamId: current.id,
      userId: pickUserId,
      organizationId: current.organizationId,
    });
    busy = false;
    if (error) return failed(error.message);
    toast.success(i18n.t.organizations.memberAdded);
    pickUserId = "";
    await loadTeamMembers(current);
  }

  async function removeMember(member: TeamMember): Promise<void> {
    if (!current) return;
    busy = true;
    const { error } = await api.auth.organization.removeTeamMember({
      teamId: current.id,
      userId: member.userId,
      organizationId: current.organizationId,
    });
    busy = false;
    if (error) return failed(error.message);
    toast.success(i18n.t.organizations.memberRemoved);
    await loadTeamMembers(current);
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>{organization?.name} · {i18n.t.organizations.teams}</Dialog.Title>
      <Dialog.Description>{i18n.t.organizations.teamsDesc}</Dialog.Description>
    </Dialog.Header>

    {#if current}
      {@const team = current}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm font-medium">{fmt(i18n.t.organizations.teamMembers, { team: team.name })}</p>
        <Button variant="outline" size="sm" onclick={() => (current = null)}>{i18n.t.organizations.backToTeams}</Button>
      </div>
      <form class="flex flex-col gap-2 sm:flex-row sm:items-end" onsubmit={addMember}>
        <div class="flex flex-1 flex-col gap-1">
          <Label for="team-member-pick">{i18n.t.organizations.pickMember}</Label>
          <Select.Root type="single" bind:value={pickUserId}>
            <Select.Trigger id="team-member-pick" class="w-full">{pickLabel(pickUserId)}</Select.Trigger>
            <Select.Content>
              {#each candidates as m (m.userId)}
                <Select.Item value={m.userId} label={m.user.name || m.user.email}>
                  {m.user.name || m.user.email} <span class="text-muted-foreground">· {m.user.email}</span>
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <Button type="submit" disabled={busy || !pickUserId}>{i18n.t.organizations.addTeamMember}</Button>
      </form>
      <DataTable
        columns={memberColumns}
        rows={teamMembers}
        getKey={(m) => m.id}
        bind:sort={memberSort}
        bind:page={memberPage}
        perPage={PER_PAGE}
        label={fmt(i18n.t.organizations.teamMembersTotal, { count: teamMembers.length })}
        empty={i18n.t.organizations.teamMembersEmpty}
      >
        {#snippet row(member, ctx)}
          <Table.Cell class="font-medium">{member.name || member.email}</Table.Cell>
          <Table.Cell class={ctx.cellClass("email")}><span class="text-muted-foreground">{member.email}</span></Table.Cell>
          <Table.Cell class="flex justify-end">
            <Button variant="ghost" size="sm" disabled={busy} onclick={() => removeMember(member)}>{i18n.t.organizations.remove}</Button>
          </Table.Cell>
        {/snippet}
      </DataTable>
    {:else}
      <form class="flex flex-col gap-2 sm:flex-row sm:items-end" onsubmit={createTeam}>
        <div class="flex flex-1 flex-col gap-1">
          <Label for="team-name">{i18n.t.organizations.teamName}</Label>
          <Input id="team-name" bind:value={newTeamName} required />
        </div>
        <Button type="submit" disabled={busy || !newTeamName.trim()}>{i18n.t.organizations.createTeam}</Button>
      </form>
      <DataTable
        columns={teamColumns}
        rows={teams}
        getKey={(t) => t.id}
        bind:sort={teamSort}
        bind:page={teamPage}
        perPage={PER_PAGE}
        label={fmt(i18n.t.organizations.teamsTotal, { count: teams.length })}
        empty={i18n.t.organizations.teamsEmpty}
      >
        {#snippet row(team, ctx)}
          <Table.Cell class="font-medium">{team.name}</Table.Cell>
          <Table.Cell class={ctx.cellClass("createdAt")}><span class="text-muted-foreground">{formatDateTime(team.createdAt)}</span></Table.Cell>
          <Table.Cell class="flex justify-end gap-1">
            <Button variant="ghost" size="sm" onclick={() => showMembers(team)}>{i18n.t.organizations.members}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onclick={() => startRename(team)}>{i18n.t.organizations.rename}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onclick={() => deleteTeam(team)}>{i18n.t.organizations.delete}</Button>
          </Table.Cell>
        {/snippet}
      </DataTable>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={renameOpen}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{i18n.t.organizations.renameTeam}</Dialog.Title>
    </Dialog.Header>
    <form class="flex flex-col gap-3" onsubmit={saveRename}>
      <div class="flex flex-col gap-1">
        <Label for="team-rename">{i18n.t.organizations.teamName}</Label>
        <Input id="team-rename" bind:value={renameValue} required />
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (renameOpen = false)}>{i18n.t.organizations.cancel}</Button>
        <Button type="submit" disabled={busy || !renameValue.trim()}>{i18n.t.organizations.save}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
