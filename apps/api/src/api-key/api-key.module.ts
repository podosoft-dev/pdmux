import { AppException } from "@podosoft/podokit-contracts";
import { Elysia } from "elysia";
import {
  ACCESS_POLICY,
  type AppPlugin,
  type PodokitModule,
  type ServiceKey,
} from "../core/services";
import { ApiKeyVerifier } from "./api-key-verifier";

export const API_KEY_VERIFIER = Symbol("api-key-verifier") as ServiceKey<ApiKeyVerifier>;

export function requireApiKey(headers: Headers, verifier: ApiKeyVerifier): void {
  const provided = headers.get("x-api-key");
  if (!provided) throw new AppException("API_KEY_REQUIRED", "Missing X-API-Key", 401);
  if (!verifier.isValid(provided)) {
    throw new AppException("API_KEY_INVALID", "Invalid API key", 401);
  }
}

const machinePlugin: AppPlugin = ({ services }) => {
  const verifier = services.resolve(API_KEY_VERIFIER);
  return new Elysia({ name: "podokit.api-key" }).get("/machine/ping", ({ request }) => {
    requireApiKey(request.headers, verifier);
    return { ok: true as const, via: "api-key" as const };
  }, {
    detail: { tags: ["machine"], summary: "Check machine API-key access" },
  });
};

export const apiKeyModule: PodokitModule = {
  name: "api-key-auth",
  configure: (_env, services): void => {
    services.register(API_KEY_VERIFIER, new ApiKeyVerifier());
    services.resolve(ACCESS_POLICY).register("GET", "/machine/ping", "api-key");
  },
  plugin: machinePlugin,
};
