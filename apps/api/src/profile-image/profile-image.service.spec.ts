import { afterAll, afterEach, describe, expect, it, jest } from "@jest/globals";
import { runUserDeletedHandlers } from "../auth/user-delete-handlers";
import { StorageService } from "../storage/storage.service";
import { ProfileImageService } from "./profile-image.service";

jest.mock("../auth/auth-provider", () => ({ getAuth: jest.fn() }));

describe("ProfileImageService account deletion cleanup", () => {
  const storage = {
    put: jest.fn(async () => undefined),
    get: jest.fn(async () => Buffer.alloc(0)),
    presignedGetUrl: jest.fn(async () => "https://example.com/image"),
    delete: jest.fn(async () => undefined),
  };
  const service = new ProfileImageService(storage as unknown as StorageService);

  service.onModuleInit();

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    service.onModuleDestroy();
  });

  it("deletes a managed image after the account is deleted", async () => {
    await runUserDeletedHandlers({
      id: "user-1",
      image: "/api/profile-images/123e4567-e89b-42d3-a456-426614174000.webp",
    });

    expect(storage.delete).toHaveBeenCalledWith(
      "profile-images/123e4567-e89b-42d3-a456-426614174000.webp",
    );
  });

  it("does not delete an external identity-provider image", async () => {
    await runUserDeletedHandlers({ id: "user-1", image: "https://example.com/avatar.png" });

    expect(storage.delete).not.toHaveBeenCalled();
  });
});
