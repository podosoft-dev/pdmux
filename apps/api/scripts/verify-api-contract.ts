import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import { validateEnv } from "../src/config/env.validation";
import { assertApiContract, documentedApiRoutes } from "../src/core/api-contract";
import { createCoreServices } from "../src/core/services";
import { PDMUX_DOCUMENTED_HTTP_ROUTES } from "../src/pdmux/pdmux.contract";

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
  const response = await app.handle(new Request("http://localhost/api-docs-json"));
  if (!response.ok) {
    throw new Error(`OpenAPI request failed (${response.status}): ${await response.text()}`);
  }
  const document: unknown = await response.json();
  const modules = manifest.modules.map((module) => module.name);
  assertApiContract(document, manifest.template, modules);
  const documented = documentedApiRoutes(document);
  const missingProductRoutes = PDMUX_DOCUMENTED_HTTP_ROUTES.filter((route) => !documented.has(route));
  if (missingProductRoutes.length > 0) {
    throw new Error(`OpenAPI is missing pdmux routes:\n${missingProductRoutes.join("\n")}`);
  }
  process.stdout.write(
    `Verified ${documented.size} documented API operations, including ${PDMUX_DOCUMENTED_HTTP_ROUTES.length} pdmux operations.\n`,
  );
} finally {
  await services.close();
}
