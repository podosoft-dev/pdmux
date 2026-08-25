export interface StorageSettings {
  provider: "minio" | "aws";
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  virtualHostedStyle: boolean;
}

export function storageSettings(): StorageSettings {
  const provider = process.env.STORAGE_PROVIDER === "aws" ? "aws" : "minio";
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  return {
    provider,
    bucket: process.env.S3_BUCKET ?? "podokit",
    region: process.env.S3_REGION ?? "us-east-1",
    virtualHostedStyle: process.env.S3_FORCE_PATH_STYLE
      ? process.env.S3_FORCE_PATH_STYLE !== "true"
      : provider === "aws",
    ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
  };
}
