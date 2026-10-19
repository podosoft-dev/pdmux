<script lang="ts">
  import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import { useSettings } from "#lib/settings/settings-state.svelte.js";
  import { getI18n } from "#lib/i18n/index.js";
  const settings = useSettings();
  const i18n = getI18n();
</script>
<DropdownMenu.Item onSelect={() => settings?.show()} data-testid="shell-user-settings"><SettingsIcon class="mr-2 size-4" />{i18n.t.settingsDialog.title}</DropdownMenu.Item>
