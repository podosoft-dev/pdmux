import { Injectable, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { createHash } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { ApiKeyVerifier } from "../api-key/api-key-verifier";
import { authRuntime } from "../auth/auth-provider";
import {
  clientAddressFromProxy,
  type RateLimitConfig,
} from "./rate-limit.config";

type SessionLike = { user?: { id?: string | null } | null } | null;
export type RateLimitRequest = Request & {
  session?: SessionLike;
  user?: unknown;
};

export abstract class RateLimitIdentityExtension {
  abstract validatedApiKeyId(
    request: RateLimitRequest,
    rawApiKey: string,
  ): Promise<string | undefined>;
}

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

@Injectable()
export class RateLimitIdentity {
  constructor(
    private readonly configuredApiKeys: ApiKeyVerifier,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async resolve(
    request: RateLimitRequest,
    config: Pick<RateLimitConfig, "proxyHeader" | "trustedProxyHops">,
  ): Promise<string> {
    const userId = await this.userId(request);
    if (userId) return tracker("user", userId);

    const rawApiKey = request.header("x-api-key");
    if (rawApiKey) {
      if (this.configuredApiKeys.isValid(rawApiKey)) {
        return tracker("api-key", rawApiKey);
      }
      const additionalIdentity = await this.additionalApiKeyIdentity(request, rawApiKey);
      if (additionalIdentity) return tracker("api-key", additionalIdentity);
    }

    const remoteAddress = request.socket?.remoteAddress ?? request.ip;
    const clientAddress = clientAddressFromProxy(request.headers, remoteAddress, config);
    return tracker("ip", clientAddress);
  }

  private async additionalApiKeyIdentity(
    request: RateLimitRequest,
    rawApiKey: string,
  ): Promise<string | undefined> {
    if (!this.moduleRef) return undefined;
    let extension: RateLimitIdentityExtension;
    try {
      extension = this.moduleRef.get(RateLimitIdentityExtension, {
        strict: false,
      });
    } catch {
      return undefined;
    }
    return extension.validatedApiKeyId(request, rawApiKey);
  }

  private async userId(request: RateLimitRequest): Promise<string | undefined> {
    if (request.session === undefined) {
      try {
        const session = await authRuntime.api.getSession({
          headers: fromNodeHeaders(request.headers),
        });
        request.session = session;
        request.user = session?.user ?? null;
      } catch {
        request.session = null;
        request.user = null;
      }
    }
    const id = request.session?.user?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }
}
