import { createHash } from "node:crypto";
import type { ApiKeyVerifier } from "../api-key/api-key-verifier";
import {
  REQUEST_IDENTITY,
  type ServiceKey,
  type ServiceRegistry,
} from "../core/services";
import {
  clientAddressFromProxy,
  type RateLimitConfig,
} from "./rate-limit.config";

export abstract class RateLimitIdentityExtension {
  abstract validatedApiKeyId(
    request: Request,
    rawApiKey: string,
  ): Promise<string | undefined>;
}

export const RATE_LIMIT_IDENTITY_EXTENSION = Symbol(
  "rate-limit-identity-extension",
) as ServiceKey<RateLimitIdentityExtension>;

function stableDigest(kind: "user" | "api-key" | "ip", value: string): string {
  return createHash("sha256")
    .update("podokit-rate-limit-v1", "utf8")
    .update("\0")
    .update(kind, "utf8")
    .update("\0")
    .update(value, "utf8")
    .digest("hex");
}

function tracker(kind: "user" | "api-key" | "ip", value: string): string {
  return `${kind}:${stableDigest(kind, value)}`;
}

export class RateLimitIdentity {
  constructor(
    private readonly configuredApiKeys: ApiKeyVerifier,
    private readonly services: ServiceRegistry,
  ) {}

  async resolve(
    request: Request,
    remoteAddress: string | undefined,
    config: Pick<RateLimitConfig, "proxyHeader" | "trustedProxyHops">,
  ): Promise<string> {
    const userId = await this.services.resolve(REQUEST_IDENTITY).userId(request);
    if (userId) return tracker("user", userId);

    const rawApiKey = request.headers.get("x-api-key");
    if (rawApiKey) {
      if (this.configuredApiKeys.isValid(rawApiKey)) return tracker("api-key", rawApiKey);
      const extension = this.services.tryResolve(RATE_LIMIT_IDENTITY_EXTENSION);
      const additionalIdentity = await extension?.validatedApiKeyId(request, rawApiKey);
      if (additionalIdentity) return tracker("api-key", additionalIdentity);
    }

    const clientAddress = clientAddressFromProxy(request.headers, remoteAddress, config);
    return tracker("ip", clientAddress);
  }
}
