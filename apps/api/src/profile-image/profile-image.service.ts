import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  AppException,
  PROFILE_IMAGE_NOT_FOUND,
  type ProfileImageResponse,
} from "@podosoft/podokit-contracts";
import { getAuth } from "../auth/auth-provider";
import { registerUserDeletedHandler } from "../auth/user-delete-handlers";
import type { StorageService } from "../storage/storage.service";
import { validateProfileImage, type ProfileImageUpload } from "./profile-image.validation";

const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;
const PUBLIC_PREFIX = "/api/profile-images/";
const STORAGE_PREFIX = "profile-images/";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export interface StoredProfileImage {
  body: Buffer;
  contentType: string;
}

export type UpdateAuthUser = (
  image: string | null,
  headers: Headers,
) => Promise<unknown>;

const updateAuthUser: UpdateAuthUser = (image, headers) =>
  getAuth().api.updateUser({ body: { image }, headers });

export class ProfileImageService {
  private unregisterUserDeleted?: () => void;

  constructor(
    private readonly storage: StorageService,
    private readonly logger: Logger,
    private readonly updateUser: UpdateAuthUser = updateAuthUser,
  ) {}

  connect(): void {
    this.unregisterUserDeleted ??= registerUserDeletedHandler(async (user) => {
      await this.deleteManagedImage(user.image ?? null);
    });
  }

  close(): void {
    this.unregisterUserDeleted?.();
    this.unregisterUserDeleted = undefined;
  }

  async upload(
    currentImage: string | null,
    file: ProfileImageUpload,
    headers: Headers,
  ): Promise<ProfileImageResponse> {
    const metadata = validateProfileImage(file);
    const fileName = `${randomUUID()}.${metadata.extension}`;
    const key = STORAGE_PREFIX + fileName;
    const image = PUBLIC_PREFIX + fileName;

    await this.storage.put(key, file.buffer, metadata.contentType);
    try {
      await this.updateUser(image, headers);
    } catch (error: unknown) {
      await this.deleteKeyBestEffort(key);
      throw error;
    }
    await this.deleteManagedImage(currentImage);
    return { image };
  }

  async remove(currentImage: string | null, headers: Headers): Promise<ProfileImageResponse> {
    await this.updateUser(null, headers);
    await this.deleteManagedImage(currentImage);
    return { image: null };
  }

  async get(fileName: string): Promise<StoredProfileImage> {
    const key = this.keyFromFileName(fileName);
    if (!key) throw new AppException(PROFILE_IMAGE_NOT_FOUND, "Profile image not found.", 404);
    try {
      const extension = fileName.slice(fileName.lastIndexOf(".") + 1);
      return {
        body: await this.storage.get(key),
        contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
      };
    } catch {
      throw new AppException(PROFILE_IMAGE_NOT_FOUND, "Profile image not found.", 404);
    }
  }

  private keyFromFileName(fileName: string): string | null {
    return FILE_NAME.test(fileName) ? STORAGE_PREFIX + fileName : null;
  }

  private keyFromPublicUrl(image: string | null): string | null {
    return image?.startsWith(PUBLIC_PREFIX)
      ? this.keyFromFileName(image.slice(PUBLIC_PREFIX.length))
      : null;
  }

  private async deleteManagedImage(image: string | null): Promise<void> {
    const key = this.keyFromPublicUrl(image);
    if (key) await this.deleteKeyBestEffort(key);
  }

  private async deleteKeyBestEffort(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error: unknown) {
      this.logger.warn(
        { key, error: error instanceof Error ? error.message : String(error) },
        "Delete profile image object failed",
      );
    }
  }
}
