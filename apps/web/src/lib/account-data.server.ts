import type { Capabilities } from "@podosoft/podokit-api-client";
import { getCapabilities, type CapabilitiesEvent } from "#lib/server/capabilities.js";

export async function loadAccountData(
  locals: App.Locals,
  fetch: CapabilitiesEvent["fetch"],
): Promise<{
  user: App.Locals["user"];
  currentSessionId: string | null;
  capabilities: Capabilities;
}> {
  return {
    user: locals.user,
    currentSessionId: locals.session?.id ?? null,
    capabilities: await getCapabilities({ locals, fetch }),
  };
}
