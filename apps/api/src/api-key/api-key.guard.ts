import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { ApiKeyVerifier } from "./api-key-verifier";

// Validates the X-API-Key header against the API_KEYS allowlist.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly verifier: ApiKeyVerifier) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header("x-api-key");
    if (!provided) {
      throw new UnauthorizedException("Missing X-API-Key");
    }
    if (!this.verifier.isValid(provided)) {
      throw new UnauthorizedException("Invalid API key");
    }
    return true;
  }
}
