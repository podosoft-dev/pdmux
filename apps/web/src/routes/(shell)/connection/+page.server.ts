import type { PageServerLoad } from "./$types";
import type { SyncConflict } from "@pdmux/desktop-protocol";
export const load: PageServerLoad = async ({ fetch }) => {
  const response = await fetch("/api/desktop/status");
  const status = response.ok ? await response.json() as {
    local: boolean; connected?: boolean; bridgeConnected?: boolean; serverUrl?: string | null;
    scopeId?: string | null; organizations?: Array<{ id: string; name: string }>; lastSync?: string | null; error?: string | null; conflicts?: SyncConflict[];
  } : { local: false };
  const agentResponse = status.local ? await fetch("/api/desktop/agents") : null;
  const agents = agentResponse?.ok ? await agentResponse.json() as { version: string; artifacts: Array<{ file: string; bytes: number; available: boolean; bundled: boolean }> } | null : null;
  return { status, agents };
};
