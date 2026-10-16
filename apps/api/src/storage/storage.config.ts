export interface StorageSettings {
  provider: "minio" | "aws";
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  virtualHostedStyle: boolean;
}

// The same S3_* then AWS_* credential variables Bun.S3Client reads, so the
// signed multipart requests use the credentials of every other request.
export function storageSettings(): StorageSettings {
  const provider = process.env.STORAGE_PROVIDER === "aws" ? "aws" : "minio";
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.S3_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN;
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
    ...(sessionToken ? { sessionToken } : {}),
  };
}
