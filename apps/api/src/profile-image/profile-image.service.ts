import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  AppException,
  PROFILE_IMAGE_NOT_FOUND,
  type ProfileImageResponse,
} from "@podosoft/podokit-contracts";
import { getAuth } from "../auth/auth-provider";
import { registerUserDeletedHandler } from "../auth/user-delete-handlers";
import { StorageService } from "../storage/storage.service";
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

@Injectable()
export class ProfileImageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProfileImageService.name);
  private unregisterUserDeleted?: () => void;

  constructor(private readonly storage: StorageService) {}

  onModuleInit(): void {
    this.unregisterUserDeleted = registerUserDeletedHandler(async (user) => {
      await this.deleteManagedImage(user.image ?? null);
    });
  }

  onModuleDestroy(): void {
    this.unregisterUserDeleted?.();
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
      await getAuth().api.updateUser({ body: { image }, headers });
    } catch (error: unknown) {
      await this.deleteKeyBestEffort(key);
      throw error;
    }
    await this.deleteManagedImage(currentImage);
    return { image };
  }

  async remove(currentImage: string | null, headers: Headers): Promise<ProfileImageResponse> {
    await getAuth().api.updateUser({ body: { image: null }, headers });
    await this.deleteManagedImage(currentImage);
    return { image: null };
  }

  async get(fileName: string): Promise<StoredProfileImage> {
    const key = this.keyFromFileName(fileName);
    if (!key) {
      throw new AppException(PROFILE_IMAGE_NOT_FOUND, "Profile image not found.", 404);
    }
    try {
      const extension = fileName.slice(fileName.lastIndexOf(".") + 1);
      return { body: await this.storage.get(key), contentType: CONTENT_TYPES[extension] ?? "application/octet-stream" };
    } catch {
      throw new AppException(PROFILE_IMAGE_NOT_FOUND, "Profile image not found.", 404);
    }
  }

  private keyFromFileName(fileName: string): string | null {
    return FILE_NAME.test(fileName) ? STORAGE_PREFIX + fileName : null;
  }

  private keyFromPublicUrl(image: string | null): string | null {
    if (!image?.startsWith(PUBLIC_PREFIX)) return null;
    return this.keyFromFileName(image.slice(PUBLIC_PREFIX.length));
  }

  private async deleteManagedImage(image: string | null): Promise<void> {
    const key = this.keyFromPublicUrl(image);
    if (key) await this.deleteKeyBestEffort(key);
  }

  private async deleteKeyBestEffort(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error: unknown) {
      this.logger.warn({
        message: "Delete profile image object failed",
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
