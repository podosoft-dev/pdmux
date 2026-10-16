import { describe, expect, it } from "bun:test";
import { EMPTY_PAYLOAD_HASH, encodeRfc3986, signS3Request } from "./s3-signer";

// The examples in the AWS documentation for Signature Version 4 header signing.
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const now = new Date("2013-05-24T00:00:00Z");

function signature(authorization: string | undefined): string | undefined {
  return /Signature=([0-9a-f]{64})$/.exec(authorization ?? "")?.[1];
}

describe("signS3Request", () => {
  it("matches the AWS example for a ranged GET", () => {
    const signed = signS3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      payloadHash: EMPTY_PAYLOAD_HASH,
    }, credentials, "us-east-1", now);
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(signed.headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(signed.headers.host).toBeUndefined();
  });

  it("matches the AWS examples for query parameters and an encoded key", () => {
    const list = signS3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/"),
      query: [["prefix", "J"], ["max-keys", "2"]],
      payloadHash: EMPTY_PAYLOAD_HASH,
    }, credentials, "us-east-1", now);
    expect(signature(list.headers.authorization)).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    expect(list.url).toBe("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J");

    const lifecycle = signS3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/"),
      query: [["lifecycle", ""]],
      payloadHash: EMPTY_PAYLOAD_HASH,
    }, credentials, "us-east-1", now);
    expect(signature(lifecycle.headers.authorization)).toBe("fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");

    const put = signS3Request({
      method: "PUT",
      url: new URL(`https://examplebucket.s3.amazonaws.com/${encodeRfc3986("test$file.text")}`),
      headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    }, credentials, "us-east-1", now);
    expect(signature(put.headers.authorization)).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("signs a session token and encodes every reserved character", () => {
    const signed = signS3Request({
      method: "DELETE",
      url: new URL("http://localhost:9000/podokit/a"),
      query: [["uploadId", "a+b/c=d e"]],
      payloadHash: EMPTY_PAYLOAD_HASH,
    }, { ...credentials, sessionToken: "token" }, "us-east-1", now);
    expect(signed.headers["x-amz-security-token"]).toBe("token");
    expect(signed.headers.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,");
    expect(signed.url).toBe("http://localhost:9000/podokit/a?uploadId=a%2Bb%2Fc%3Dd%20e");
    expect(encodeRfc3986("a b!*'()~._-")).toBe("a%20b%21%2A%27%28%29~._-");
  });
});
