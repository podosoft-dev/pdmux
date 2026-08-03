import type { PageServerLoad } from "./$types";
import type { Capabilities } from "@podosoft/podokit-api-client";

export const load: PageServerLoad = async ({ fetch }) => {
  try {
    const res = await fetch("/api/account/capabilities");
    if (res.ok) return { capabilities: (await res.json()) as Capabilities };
  } catch {
    /* fall through to a safe default */
  }
  return { capabilities: null };
};
