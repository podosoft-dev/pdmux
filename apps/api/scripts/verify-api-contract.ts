import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { validateEnv } from "../src/config/env.validation";
import {
  assertApiContract,
  assertApplicationRoutes,
  assertConsistentRouteParameters,
  documentedApiRoutes,
} from "../src/core/api-contract";
import { APP_DOCUMENTED_ROUTES } from "../src/core/api-contract.extensions";
import { createCoreServices } from "../src/core/services";
import { PROVIDERS } from "../src/config/providers";

interface ProjectManifest {
  template: string;
  modules: Array<{ name: string }>;
}

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../.podokit/manifest.json"), "utf8"),
) as ProjectManifest;
const env = validateEnv(process.env);
const services = createCoreServices(env);
const app = createApp({ env, services });
try {
  assertConsistentRouteParameters(app.routes);
  const response = await app.handle(new Request("http://localhost/api-docs-json"));
  if (!response.ok) {
    throw new Error(`OpenAPI request failed (${response.status}): ${await response.text()}`);
  }
  const document: unknown = await response.json();
  // A provider module such as object-storage-local registers its routes only
  // while its provider is selected, so the contract expects them only then.
  const modules = manifest.modules.map((module) => module.name).filter((name) =>
    Object.entries(PROVIDERS).every(([capability, provider]) =>
      !name.startsWith(`${capability}-`) || name === `${capability}-${provider}`));
  assertApiContract(document, manifest.template, modules);
  assertApplicationRoutes(document, app.routes, APP_DOCUMENTED_ROUTES);
  process.stdout.write(
    `Verified ${documentedApiRoutes(document).size} documented API operations for ${manifest.template}, ` +
      `including ${APP_DOCUMENTED_ROUTES.length} application operations.\n`,
  );
} finally {
  await services.close();
}
