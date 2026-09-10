<script lang="ts">
  import { onDestroy } from "svelte";
  import FilesDock from "../../src/lib/dashboard/components/files-dock.svelte";
  import { FilesDock as DockState } from "../../src/lib/dashboard/files-dock.svelte";
  import type { HostView } from "../../src/lib/dashboard/types";
  const hostId = "11111111-1111-4111-8111-111111111111";
  const files = new DockState();
  files.hostId = hostId;
  files.path = "destination";
  files.dir = {
    path: files.path, home: "/home/example", entries: [
      { name: "folder", dir: true, symlink: false, size: 0, mode: 0o700, modified: 1 },
      { name: "file.txt", dir: false, symlink: false, size: 7, mode: 0o600, modified: 1 },
    ], dropped: 0, truncated: false, error: null,
  };
  const hosts = [{ id: hostId, label: "Test host", capabilities: ["files", "files-transfer-v1"] }] as HostView[];
  onDestroy(() => files.transfers.dispose());
</script>
<main class="pdmux h-screen max-w-[440px] min-w-0">
  <div class="flex h-full min-h-0">
    <FilesDock {files} {hosts} onHostChange={(id) => void files.openHost(id)} onOpenDir={(path) => void files.openDir(path)} onNavigate={(path) => void files.navigate(path, null)} />
  </div>
</main>
