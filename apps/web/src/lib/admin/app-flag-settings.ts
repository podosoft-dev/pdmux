import type { Capabilities } from "@podosoft/podokit-api-client";
import type { Messages } from "#lib/i18n/messages.js";
import { APP_FLAG_SETTINGS } from "./app-flags";
import type { AppFlagSetting } from "./registry.svelte.js";

export type AppFlagCard = {
  flag: string;
  name: string;
  description: string;
  /** False when the API does not report the flag, for example a name missing from APP_FLAG_DEFAULTS. */
  available: boolean;
  on: boolean;
};

/** One card per listed flag, with the value `GET /account/capabilities` reports in `appFlags`. */
export function appFlagCards(
  t: Messages,
  capabilities: Pick<Capabilities, "appFlags"> | undefined,
  settings: readonly AppFlagSetting[] = APP_FLAG_SETTINGS,
): AppFlagCard[] {
  return settings.map(({ flag, label, description }) => {
    const value = capabilities?.appFlags?.[flag];
    return {
      flag,
      name: label(t),
      description: description?.(t) ?? "",
      available: typeof value === "boolean",
      on: value === true,
    };
  });
}
