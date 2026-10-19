import type { AppEnv } from "../config/env.validation";
import { apiServerOptions, type ApiServerOptions } from "../config/server-options";
import { LOGGER, SHUTDOWN, type ServiceRegistry } from "./services";
import { stopGracefully, type StoppableServer } from "./shutdown";

export interface ListeningServer extends StoppableServer {
  readonly port?: number;
  readonly pendingRequests: number;
  readonly pendingWebSockets: number;
}

/** The part of the Elysia app that serving needs. */
export interface ServedApp {
  listen(options: Required<ApiServerOptions> & { hostname: string; port: number }): unknown;
  /** Stops the server gently and runs the app's `onStop` hooks. */
  stop(): Promise<unknown>;
  readonly server: ListeningServer | null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts the services and listens. On SIGINT or SIGTERM it stops accepting
 * connections, ends streams and WebSockets, gives in-flight requests up to
 * SHUTDOWN_TIMEOUT seconds, closes the services, and exits; a second signal
 * exits at once.
 */
export async function serveApi(app: ServedApp, env: AppEnv, services: ServiceRegistry): Promise<void> {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) process.exit(1);
    stopping = true;
    const logger = services.resolve(LOGGER);
    const server = app.server;
    logger.info(
      {
        signal,
        pendingRequests: server?.pendingRequests ?? 0,
        pendingWebSockets: server?.pendingWebSockets ?? 0,
        shutdownTimeoutSeconds: env.SHUTDOWN_TIMEOUT,
      },
      "Shut down the API",
    );
    void stopGracefully({
      stop: () => (server ? app.stop() : Promise.resolve()),
      ...(server ? { server } : {}),
      shutdown: services.resolve(SHUTDOWN),
      closeServices: () => services.close().catch((error: unknown) => {
        logger.warn({ reason: reasonOf(error) }, "Close services failed");
      }),
      timeoutMs: env.SHUTDOWN_TIMEOUT * 1000,
    })
      .then(({ drained, servicesClosed }) => {
        if (!drained) {
          logger.warn(
            { shutdownTimeoutSeconds: env.SHUTDOWN_TIMEOUT },
            "Force-close connections still open after the shutdown timeout",
          );
        }
        if (!servicesClosed) logger.warn("Exit before the services finished closing");
      })
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await services.start();
    app.listen({ ...apiServerOptions(env), hostname: env.HOST, port: env.PORT });
    process.stdout.write(`API listening on http://${env.HOST}:${app.server?.port ?? env.PORT}\n`);
  } catch (error) {
    await services.close();
    throw error;
  }
}
