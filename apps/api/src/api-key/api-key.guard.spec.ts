import { describe, expect, it, jest } from "@jest/globals";
import { type ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { ApiKeyVerifier } from "./api-key-verifier";
import { ApiKeyGuard } from "./api-key.guard";

function requestContext(apiKey?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        header: (name: string) => (name === "x-api-key" ? apiKey : undefined),
      }),
    }),
  } as unknown as ExecutionContext;
}

describe("ApiKeyGuard", () => {
  it("delegates a supplied key to the shared verifier", () => {
    const verifier = {
      isValid: jest.fn<(provided: string) => boolean>(() => true),
    };
    const guard = new ApiKeyGuard(verifier as unknown as ApiKeyVerifier);

    expect(guard.canActivate(requestContext("service-key"))).toBe(true);
    expect(verifier.isValid).toHaveBeenCalledWith("service-key");
  });

  it("rejects a missing key without invoking the verifier", () => {
    const verifier = {
      isValid: jest.fn<(provided: string) => boolean>(() => true),
    };
    const guard = new ApiKeyGuard(verifier as unknown as ApiKeyVerifier);

    expect(() => guard.canActivate(requestContext())).toThrow(
      new UnauthorizedException("Missing X-API-Key"),
    );
    expect(verifier.isValid).not.toHaveBeenCalled();
  });

  it("rejects a key that the verifier does not recognize", () => {
    const verifier = {
      isValid: jest.fn<(provided: string) => boolean>(() => false),
    };
    const guard = new ApiKeyGuard(verifier as unknown as ApiKeyVerifier);

    expect(() => guard.canActivate(requestContext("invalid-key"))).toThrow(
      new UnauthorizedException("Invalid API key"),
    );
  });
});
