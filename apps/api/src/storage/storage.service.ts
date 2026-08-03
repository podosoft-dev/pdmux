import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ReadinessService } from "../health/readiness.service";
import { storageClientConfig, storageSettings } from "./storage.config";

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly client = new S3Client(storageClientConfig());
  private readonly bucket = storageSettings().bucket;
  private unregisterReadiness?: () => void;

  constructor(private readonly readiness: ReadinessService) {}

  onModuleInit(): void {
    this.unregisterReadiness = this.readiness.register("object-storage", async () => {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
        { abortSignal: AbortSignal.timeout(3_000) },
      );
    });
  }

  async put(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    return Buffer.from(bytes ?? new Uint8Array());
  }

  presignedGetUrl(key: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  onModuleDestroy(): void {
    this.unregisterReadiness?.();
    this.client.destroy();
  }
}
