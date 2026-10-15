import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalObjectStore } from "@podosoft/podokit-runtime";
import { DownloadUrlSigner, objectKeyFromPath, SignedDownloadStore } from "./download-url";

let root: string | undefined;

async function tempRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "podokit-download-url-"));
  return root;
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("DownloadUrlSigner", () => {
  it("accepts only the signed key before it expires", async () => {
    const keyFile = join(await tempRoot(), ".podokit", "download-url.key");
    const now = 1_700_000_000_000;
    const signer = new DownloadUrlSigner(keyFile, () => now);
    const { expires, signature } = await signer.sign("uploads/a/file.txt", 60);

    expect(expires).toBe(String(now / 1000 + 60));
    expect(await signer.verify("uploads/a/file.txt", expires, signature)).toBe(true);
    expect(await signer.verify("uploads/b/file.txt", expires, signature)).toBe(false);
    expect(await signer.verify("uploads/a/file.txt", String(Number(expires) + 1), signature)).toBe(false);
    expect(await signer.verify("uploads/a/file.txt", expires, `${signature.slice(0, -2)}AA`)).toBe(false);
    expect(await signer.verify("uploads/a/file.txt", undefined, signature)).toBe(false);
    expect(await signer.verify("uploads/a/file.txt", expires, undefined)).toBe(false);
    expect(await signer.verify("uploads/a/file.txt", "1e9", signature)).toBe(false);

    const later = new DownloadUrlSigner(keyFile, () => now + 61_000);
    expect(await later.verify("uploads/a/file.txt", expires, signature)).toBe(false);
  });

  it("persists one private key for every signer that shares the key file", async () => {
    const keyFile = join(await tempRoot(), ".podokit", "download-url.key");
    const [first, second] = [new DownloadUrlSigner(keyFile), new DownloadUrlSigner(keyFile)];
    const [signed] = await Promise.all([first.sign("demo/hello"), second.sign("demo/other")]);

    expect(await second.verify("demo/hello", signed.expires, signed.signature)).toBe(true);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
  });

  it("caps the lifetime at seven days", async () => {
    const keyFile = join(await tempRoot(), "download-url.key");
    const signer = new DownloadUrlSigner(keyFile, () => 0);
    const { expires } = await signer.sign("demo/hello", 365 * 24 * 60 * 60);
    expect(Number(expires)).toBe(7 * 24 * 60 * 60);
  });
});

describe("objectKeyFromPath", () => {
  it("decodes each path segment and rejects malformed encodings", () => {
    expect(objectKeyFromPath("uploads/user%20one/a.txt")).toBe("uploads/user one/a.txt");
    expect(objectKeyFromPath("uploads/%E0%A4%A")).toBeUndefined();
  });
});

describe("SignedDownloadStore", () => {
  it("adds a verifiable signature to local download URLs", async () => {
    const directory = await tempRoot();
    const signer = new DownloadUrlSigner(join(directory, ".podokit", "download-url.key"));
    const store = new SignedDownloadStore(
      new LocalObjectStore({ rootDirectory: directory, publicBaseUrl: "/files/content" }),
      signer,
      "/files/content",
    );
    await store.put("uploads/user one.txt", "hello", { contentType: "text/plain" });

    const url = new URL(await store.getDownloadUrl("uploads/user one.txt"), "http://localhost");
    expect(url.pathname).toBe("/files/content/uploads/user%20one.txt");
    expect(
      await signer.verify(
        "uploads/user one.txt",
        url.searchParams.get("expires") ?? undefined,
        url.searchParams.get("signature") ?? undefined,
      ),
    ).toBe(true);
    await expect(store.getDownloadUrl("../outside.txt")).rejects.toThrow("safe relative path");
  });
});
