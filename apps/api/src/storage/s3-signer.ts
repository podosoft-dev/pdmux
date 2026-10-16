import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignedRequestInput {
  method: string;
  /** The request URL without a query string; the path must already be encoded. */
  url: URL;
  query?: ReadonlyArray<readonly [string, string]>;
  headers?: Record<string, string>;
  /** The hex SHA-256 of the body, or UNSIGNED-PAYLOAD. */
  payloadHash: string;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

export const EMPTY_PAYLOAD_HASH = createHash("sha256").update("").digest("hex");
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** Percent-encodes everything but RFC 3986 unreserved characters, as SigV4 requires. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Signs an S3 request with AWS Signature Version 4 in the Authorization header.
 * Bun's S3Client signs its own requests but exposes no multipart operations,
 * so the multipart calls are signed here.
 */
export function signS3Request(
  input: SignedRequestInput,
  credentials: S3Credentials,
  region: string,
  now: Date = new Date(),
): SignedRequest {
  const timestamp = amzDate(now);
  const day = timestamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value;
  headers.host = input.url.host;
  headers["x-amz-date"] = timestamp;
  headers["x-amz-content-sha256"] = input.payloadHash;
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(headers[name] ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const query = (input.query ?? [])
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName < rightName ? -1 : leftName > rightName ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  // Bun's fetch sets Host from the URL.
  delete headers.host;
  return { url: query ? `${input.url.href}?${query}` : input.url.href, headers };
}
