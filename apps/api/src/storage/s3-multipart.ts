import {
  MultipartUploadError,
  type CompletedPart,
  type MultipartUploadErrorCode,
} from "@podosoft/podokit-runtime";
import {
  EMPTY_PAYLOAD_HASH,
  encodeRfc3986,
  signS3Request,
  UNSIGNED_PAYLOAD,
  type S3Credentials,
} from "./s3-signer";

export interface S3Target {
  bucket: string;
  region: string;
  /** Defaults to the AWS regional endpoint. */
  endpoint?: string;
  virtualHostedStyle: boolean;
  credentials: S3Credentials;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ERROR_CODES: Record<string, MultipartUploadErrorCode> = {
  NoSuchUpload: "UPLOAD_NOT_FOUND",
  InvalidPart: "INVALID_PART",
  InvalidPartOrder: "INVALID_PART",
  EntityTooSmall: "PART_TOO_SMALL",
};

function xmlValue(xml: string, element: string): string | undefined {
  const match = new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml);
  return match?.[1]
    ?.replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function s3Error(operation: string, status: number, xml: string): Error {
  const code = xmlValue(xml, "Code");
  const message = xmlValue(xml, "Message") ?? `status ${status}`;
  const mapped = code ? ERROR_CODES[code] : undefined;
  if (mapped) return new MultipartUploadError(mapped, `${operation} failed: ${message}`);
  return new Error(`${operation} failed with ${code ?? `status ${status}`}: ${message}`);
}

/**
 * S3 multipart operations over signed requests: create, upload part, complete,
 * and abort. Works with AWS S3 and MinIO-compatible services such as Silo.
 */
export class S3Multipart {
  private readonly base: URL;

  constructor(
    private readonly target: S3Target,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.base = new URL(target.endpoint ?? `https://s3.${target.region}.amazonaws.com`);
  }

  async create(key: string, contentType?: string): Promise<string> {
    const response = await this.send("POST", key, [["uploads", ""]], {
      ...(contentType ? { "content-type": contentType } : {}),
    });
    const xml = await response.text();
    if (!response.ok) throw s3Error("CreateMultipartUpload", response.status, xml);
    const uploadId = xmlValue(xml, "UploadId");
    if (!uploadId) throw new Error("CreateMultipartUpload returned no upload id");
    return uploadId;
  }

  /** Returns the part's entity tag. The body's length must be known, as S3 requires. */
  async uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array | Blob): Promise<string> {
    const response = await this.send(
      "PUT",
      key,
      [["partNumber", String(partNumber)], ["uploadId", uploadId]],
      {},
      body,
    );
    const xml = await response.text();
    if (!response.ok) throw s3Error("UploadPart", response.status, xml);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("UploadPart returned no entity tag");
    return etag;
  }

  async complete(key: string, uploadId: string, parts: readonly CompletedPart[]): Promise<void> {
    const document = [
      "<CompleteMultipartUpload>",
      ...parts.map((part) =>
        `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`
      ),
      "</CompleteMultipartUpload>",
    ].join("");
    const response = await this.send(
      "POST",
      key,
      [["uploadId", uploadId]],
      { "content-type": "application/xml" },
      new TextEncoder().encode(document),
    );
    const xml = await response.text();
    // S3 can report a failed completion inside a 200 response.
    if (!response.ok || xml.includes("<Error>")) {
      throw s3Error("CompleteMultipartUpload", response.status, xml);
    }
  }

  /** Resolves when the upload no longer exists, including when it never did. */
  async abort(key: string, uploadId: string): Promise<void> {
    const response = await this.send("DELETE", key, [["uploadId", uploadId]]);
    const xml = await response.text();
    if (response.ok) return;
    const error = s3Error("AbortMultipartUpload", response.status, xml);
    if (error instanceof MultipartUploadError && error.code === "UPLOAD_NOT_FOUND") return;
    throw error;
  }

  private objectUrl(key: string): URL {
    const url = new URL(this.base.href);
    const basePath = url.pathname.replace(/\/$/, "");
    const encodedKey = key.split("/").map(encodeRfc3986).join("/");
    if (this.target.virtualHostedStyle) {
      url.hostname = `${this.target.bucket}.${url.hostname}`;
      url.pathname = `${basePath}/${encodedKey}`;
    } else {
      url.pathname = `${basePath}/${encodeRfc3986(this.target.bucket)}/${encodedKey}`;
    }
    return url;
  }

  private send(
    method: string,
    key: string,
    query: ReadonlyArray<readonly [string, string]>,
    headers: Record<string, string> = {},
    body?: Uint8Array | Blob,
  ): Promise<Response> {
    const signed = signS3Request(
      {
        method,
        url: this.objectUrl(key),
        query,
        headers,
        // Payloads are sent unsigned so a part never has to be hashed before it is sent.
        payloadHash: body === undefined ? EMPTY_PAYLOAD_HASH : UNSIGNED_PAYLOAD,
      },
      this.target.credentials,
      this.target.region,
    );
    return this.fetchImpl(signed.url, {
      method,
      headers: signed.headers,
      // Bytes on a SharedArrayBuffer are not a BodyInit in lib.dom; S3 parts never are.
      ...(body === undefined ? {} : { body: body as BodyInit }),
    });
  }
}
