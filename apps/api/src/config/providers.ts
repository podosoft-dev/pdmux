import type { ProviderSelections } from "@podosoft/podokit-runtime";
import { providersFromEnvironment } from "./provider-selection";

// The providers selected when the project was generated or by `podo provider
// set`. Typed with every provider name, not the selected ones: the module of a
// provider that stays installed after a switch compares against its own name.
// A <CAPABILITY>_PROVIDER variable replaces one at startup; see
// provider-selection.ts.
export const PROVIDERS: Readonly<ProviderSelections> = providersFromEnvironment({
  database: "postgres",
  cache: "redis",
  "object-storage": "s3",
  events: "redis",
  jobs: "bullmq",
});
