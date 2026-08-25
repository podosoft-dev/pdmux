import { S3Client } from "bun";
import { ReadinessService } from "../health/readiness.service";
import { storageSettings } from "./storage.config";

export class StorageService {
  private readonly client: S3Client;
  private unregisterReadiness?: () => void;

  constructor(readiness: ReadinessService) {
    const settings = storageSettings();
    this.client = new S3Client({
      bucket: settings.bucket,
      region: settings.region,
      virtualHostedStyle: settings.virtualHostedStyle,
      ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
      ...(settings.accessKeyId ? { accessKeyId: settings.accessKeyId } : {}),
      ...(settings.secretAccessKey ? { secretAccessKey: settings.secretAccessKey } : {}),
    });
    this.unregisterReadiness = readiness.register("object-storage", async () => {
      await this.client.exists(".podokit-readiness");
    });
  }

  async put(key: string, body: Uint8Array | string | Blob, contentType?: string): Promise<void> {
    await this.client.file(key).write(body, contentType ? { type: contentType } : undefined);
  }

  async get(key: string): Promise<Buffer> {
    return Buffer.from(await this.client.file(key).bytes());
  }

  async exists(key: string): Promise<boolean> {
    return this.client.exists(key);
  }

  presignedGetUrl(key: string, expiresIn = 3600): Promise<string> {
    return Promise.resolve(this.client.presign(key, { expiresIn }));
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }

  close(): void {
    this.unregisterReadiness?.();
  }
}
