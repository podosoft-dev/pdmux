import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { Logger } from "pino";
import { runUserDeletedHandlers } from "../auth/user-delete-handlers";
import { StorageService } from "../storage/storage.service";
import { ProfileImageService } from "./profile-image.service";

describe("ProfileImageService account deletion cleanup", () => {
  const storage = {
    put: mock(async () => undefined),
    get: mock(async () => Buffer.alloc(0)),
    presignedGetUrl: mock(async () => "https://example.com/image"),
    delete: mock(async () => undefined),
  };
  const logger = { warn: mock(() => undefined) } as unknown as Logger;
  const service = new ProfileImageService(storage as unknown as StorageService, logger);

  service.connect();

  afterEach(() => {
    for (const operation of Object.values(storage)) operation.mockClear();
  });

  afterAll(() => {
    service.close();
  });

  test("deletes a managed image after the account is deleted", async () => {
    await runUserDeletedHandlers({
      id: "user-1",
      image: "/api/profile-images/123e4567-e89b-42d3-a456-426614174000.webp",
    });

    expect(storage.delete).toHaveBeenCalledWith(
      "profile-images/123e4567-e89b-42d3-a456-426614174000.webp",
    );
  });

  test("does not delete an external identity-provider image", async () => {
    await runUserDeletedHandlers({ id: "user-1", image: "https://example.com/avatar.png" });

    expect(storage.delete).not.toHaveBeenCalled();
  });
});
