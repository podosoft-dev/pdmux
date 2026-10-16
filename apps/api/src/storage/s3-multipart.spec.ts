import { describe, expect, it } from "bun:test";
import { MultipartUploadError } from "@podosoft/podokit-runtime";
import { S3Multipart, type S3Target } from "./s3-multipart";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeS3(...responses: Response[]): { calls: Call[]; fetch: (input: string, init: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({
        url: input,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body === undefined ? undefined : await new Response(init.body as BodyInit).text(),
      });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    },
  };
}

function errorXml(code: string, status: number): Response {
  return new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code} message</Message></Error>`, {
    status,
  });
}

const target: S3Target = {
  bucket: "podokit",
  region: "us-east-1",
  endpoint: "http://localhost:9000",
  virtualHostedStyle: false,
  credentials: { accessKeyId: "podokit", secretAccessKey: "podokitsecret" },
};

describe("S3Multipart", () => {
  it("creates, uploads, completes, and aborts with signed path-style requests", async () => {
    const s3 = fakeS3(
      new Response("<InitiateMultipartUploadResult><UploadId>id+1/2</UploadId></InitiateMultipartUploadResult>"),
      new Response("", { headers: { etag: "\"abc\"" } }),
      new Response("<CompleteMultipartUploadResult><ETag>&quot;x-1&quot;</ETag></CompleteMultipartUploadResult>"),
      new Response(null, { status: 204 }),
    );
    const multipart = new S3Multipart(target, s3.fetch);

    const uploadId = await multipart.create("videos/a b+c.mp4", "video/mp4");
    expect(uploadId).toBe("id+1/2");
    expect(await multipart.uploadPart("videos/a b+c.mp4", uploadId, 1, new TextEncoder().encode("part"))).toBe("\"abc\"");
    await multipart.complete("videos/a b+c.mp4", uploadId, [{ partNumber: 1, etag: "\"abc\"" }]);
    await multipart.abort("videos/a b+c.mp4", uploadId);

    const object = "http://localhost:9000/podokit/videos/a%20b%2Bc.mp4";
    expect(s3.calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${object}?uploads=`],
      ["PUT", `${object}?partNumber=1&uploadId=id%2B1%2F2`],
      ["POST", `${object}?uploadId=id%2B1%2F2`],
      ["DELETE", `${object}?uploadId=id%2B1%2F2`],
    ]);
    expect(s3.calls[0]?.headers["content-type"]).toBe("video/mp4");
    expect(s3.calls[1]?.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(s3.calls[1]?.body).toBe("part");
    expect(s3.calls[2]?.body).toBe(
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;abc&quot;</ETag></Part></CompleteMultipartUpload>",
    );
    for (const call of s3.calls) {
      expect(call.headers.authorization).toStartWith("AWS4-HMAC-SHA256 Credential=podokit/");
    }
  });

  it("addresses the bucket by host name in virtual-hosted style and on AWS by default", async () => {
    const s3 = fakeS3(
      new Response("<UploadId>one</UploadId>"),
      new Response("<UploadId>two</UploadId>"),
    );
    await new S3Multipart({ ...target, virtualHostedStyle: true }, s3.fetch).create("a.txt");
    const { endpoint: _endpoint, ...aws } = target;
    await new S3Multipart({ ...aws, region: "eu-west-1", virtualHostedStyle: true }, s3.fetch).create("a.txt");
    expect(s3.calls.map((call) => call.url)).toEqual([
      "http://podokit.localhost:9000/a.txt?uploads=",
      "https://podokit.s3.eu-west-1.amazonaws.com/a.txt?uploads=",
    ]);
  });

  it("maps S3 error codes to multipart error codes", async () => {
    const s3 = fakeS3(
      errorXml("NoSuchUpload", 404),
      errorXml("InvalidPart", 400),
      // S3 may report a failed completion in a 200 response.
      new Response("<Error><Code>EntityTooSmall</Code><Message>small</Message></Error>"),
      errorXml("AccessDenied", 403),
      errorXml("NoSuchUpload", 404),
    );
    const multipart = new S3Multipart(target, s3.fetch);
    const codeOf = (error: unknown): string | undefined =>
      error instanceof MultipartUploadError ? error.code : undefined;

    expect(codeOf(await multipart.uploadPart("a", "x", 1, new Uint8Array(1)).catch((error: unknown) => error)))
      .toBe("UPLOAD_NOT_FOUND");
    expect(codeOf(await multipart.complete("a", "x", [{ partNumber: 1, etag: "e" }]).catch((error: unknown) => error)))
      .toBe("INVALID_PART");
    expect(codeOf(await multipart.complete("a", "x", [{ partNumber: 1, etag: "e" }]).catch((error: unknown) => error)))
      .toBe("PART_TOO_SMALL");
    await expect(multipart.create("a")).rejects.toThrow("AccessDenied");
    // Aborting an upload that is already gone succeeds.
    await multipart.abort("a", "x");
  });
});
