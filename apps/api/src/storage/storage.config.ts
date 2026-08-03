import type { S3ClientConfig } from "@aws-sdk/client-s3";

export interface StorageSettings {
  provider: "minio" | "aws";
  bucket: string;
}

export function storageSettings(): StorageSettings {
  const provider = process.env.STORAGE_PROVIDER === "aws" ? "aws" : "minio";
  return { provider, bucket: process.env.S3_BUCKET ?? "podokit" };
}

// Build an S3 client config that works for both AWS S3 and MinIO.
// MinIO needs a custom endpoint and path-style addressing; AWS does not.
export function storageClientConfig(): S3ClientConfig {
  const { provider } = storageSettings();
  const region = process.env.S3_REGION ?? "us-east-1";

  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const credentials = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;

  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE
    ? process.env.S3_FORCE_PATH_STYLE === "true"
    : provider === "minio";

  const config: S3ClientConfig = { region, forcePathStyle };
  if (credentials) config.credentials = credentials;
  if (process.env.S3_ENDPOINT) config.endpoint = process.env.S3_ENDPOINT;
  return config;
}
