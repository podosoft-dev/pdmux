import { AppException } from "@podosoft/podokit-contracts";
import { APIError } from "better-auth/api";

/** Resolves whether the database answers now. */
export type DatabaseProbe = () => Promise<boolean>;

export function databaseUnavailable(): AppException {
  return new AppException("DATABASE_UNAVAILABLE", "The database is temporarily unavailable", 503);
}

/** Whether `query` succeeds within `timeoutMs`; a query still waiting then counts as failed. */
export async function answersWithin(query: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([query().then(() => true, () => false), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Lets concurrent callers share one run of `probe`. */
export function sharedProbe(probe: DatabaseProbe): DatabaseProbe {
  let running: Promise<boolean> | undefined;
  return () => {
    running ??= probe().finally(() => {
      running = undefined;
    });
    return running;
  };
}

// Better Auth answers a failed query with a bare 500, and its session lookup
// replaces the cause with INTERNAL_SERVER_ERROR. A server error is therefore
// checked against the database itself before it is reported.

/** Passes `response` on, unless it is a server error while the database does not answer. */
export async function checkAuthResponse(response: Response, reachable: DatabaseProbe): Promise<Response> {
  if (response.status < 500 || (await reachable())) return response;
  throw databaseUnavailable();
}

/** Rethrows `error`, as DATABASE_UNAVAILABLE when it is a server error while the database does not answer. */
export async function rethrowAuthError(error: unknown, reachable: DatabaseProbe): Promise<never> {
  const clientError = error instanceof APIError && error.statusCode < 500;
  if (!clientError && !(await reachable())) throw databaseUnavailable();
  throw error;
}
