import { createApp } from "./app";
import { validateEnv } from "./config/env.validation";
import { serveApi } from "./core/serve";
import { createCoreServices, LOGGER, READINESS, SHUTDOWN } from "./core/services";
import { applyDevelopmentMigrations } from "./database/development-migrations";

const env = validateEnv(process.env);
const services = createCoreServices(env);
const app = createApp({ env, services });

async function main(): Promise<void> {
  await applyDevelopmentMigrations(env, services.resolve(READINESS), services.resolve(LOGGER), {
    signal: services.resolve(SHUTDOWN).signal,
  });
  await serveApi(app, env, services);
}

void main();
