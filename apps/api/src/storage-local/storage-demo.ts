import { AppException } from "@podosoft/podokit-contracts";
import { t } from "elysia";
import type { RequestIdentity } from "../core/services";

/**
 * The demo routes only reach objects under this prefix, so even an
 * administrator cannot overwrite keys owned by other features such as
 * uploads, profile images, or the site favicon.
 */
export const DEMO_KEY_PREFIX = "demo/";

/**
 * One path segment. Elysia decodes `%2F` inside `:key`, so the pattern rejects
 * slashes and leading dots instead of trusting the router.
 */
export const demoKeyParams = t.Object({
  key: t.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
});

export function demoObjectKey(name: string): string {
  return `${DEMO_KEY_PREFIX}${name}`;
}

export function storageObjectNotFound(): AppException {
  return new AppException("STORAGE_OBJECT_NOT_FOUND", "Object not found", 404);
}

export async function requireStorageAdmin(
  identity: RequestIdentity,
  request: Request,
): Promise<void> {
  if (!(await identity.userId(request))) {
    throw new AppException("AUTH_REQUIRED", "Authentication is required", 401);
  }
  if (!(await identity.isAdmin(request))) {
    throw new AppException("ADMIN_REQUIRED", "Administrator access is required", 403);
  }
}
