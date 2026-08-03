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

/**
 * The bearer credential on `/mcp`, if this request carries one.
 *
 * WHY `/mcp` IS SPECIAL HERE: it is the one authenticated surface with no session
 * cookie, so `userId()` finds nothing and the request falls through to the address
 * bucket. Behind the web app's proxy every MCP request shares the proxy's address,
 * which made the whole install one bucket — a busy coding agent could 429 the
 * dashboard. This branch also skips the `getSession()` call that could never have
 * succeeded for a bearer credential.
 *
 * ⚠ NOTHING HERE VALIDATES THE TOKEN, deliberately. Rate limiting runs before
 * authentication; a lookup here would hand an unauthenticated caller a database
 * read per request, which is the thing rate limiting is supposed to prevent.
 */
function mcpBearer(request: RateLimitRequest): string | null {
  if (request.path !== "/mcp") return null;
  const header = request.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length).trim();
  return value.length > 0 ? value : null;
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
    const bearer = mcpBearer(request);
    if (bearer) {
      // ⚠ THE ADDRESS IS PART OF THE KEY, AND THAT IS THE WHOLE POINT. Tracking on
      // the token alone would be worse than tracking on the address: somebody
      // spraying random well-formed strings would earn a FRESH BUCKET PER GUESS and
      // face no limit at all. Pairing them means a real caller stops sharing a
      // bucket with the whole install (the bug this fixes) while a sprayer stays
      // pinned to one bucket per address, exactly as before.
      //
      // The token is hashed here rather than passed through: `stableDigest` is not
      // a promise about secrecy, and a credential should not travel into a storage
      // key even one that hashes it again.
      const remote = clientAddressFromProxy(request.headers, request.socket?.remoteAddress ?? request.ip, config);
      return tracker("api-key", `${remote}\0${stableDigest("api-key", bearer)}`);
    }

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
