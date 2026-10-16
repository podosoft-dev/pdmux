import type { ProviderSelections } from "@podosoft/podokit-runtime";
import { runtimeProviders } from "../runtime/providers";

// pdmux selects providers at startup (server or desktop) instead of at generation
// time; `.podokit/manifest.json` records the server selection for deployments.
export const PROVIDERS: Readonly<ProviderSelections> = runtimeProviders(process.env);
