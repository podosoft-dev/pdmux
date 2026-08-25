import { createApp } from "./app";
import { validateEnv } from "./config/env.validation";
import { createCoreServices } from "./core/services";

const env = validateEnv(process.env);
const services = createCoreServices(env);
const app = createApp({ env, services });

async function bootstrap(): Promise<void> {
  try {
    await services.start();
    app.listen({ hostname: "0.0.0.0", port: env.PORT });
    process.stdout.write(`API listening on http://0.0.0.0:${env.PORT}\n`);
  } catch (error) {
    await services.close();
    throw error;
  }
}

void bootstrap();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.stop();
      await services.close();
      process.exit(0);
    })();
  });
}
