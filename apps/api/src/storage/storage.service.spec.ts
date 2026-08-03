import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, jest } from "@jest/globals";
import type { ReadinessService } from "../health/readiness.service";
import { StorageService } from "./storage.service";

describe("StorageService readiness", () => {
  it("registers a bucket probe and releases resources on shutdown", async () => {
    const unregister = jest.fn();
    const register = jest.fn<
      (name: string, check: () => Promise<void>) => () => void
    >(() => unregister);
    const service = new StorageService({ register } as unknown as ReadinessService);
    const send = jest
      .fn<(...arguments_: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const destroy = jest.fn();
    Object.defineProperty(service, "client", {
      value: { send, destroy },
    });

    service.onModuleInit();
    expect(register).toHaveBeenCalledWith("object-storage", expect.any(Function));
    const probe = register.mock.calls[0]?.[1];
    expect(probe).toBeDefined();
    await probe?.();
    expect(send).toHaveBeenCalledWith(
      expect.any(HeadBucketCommand),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );

    service.onModuleDestroy();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
