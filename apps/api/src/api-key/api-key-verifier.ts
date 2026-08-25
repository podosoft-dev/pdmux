import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class ApiKeyVerifier {
  private readonly keyDigests = (process.env.API_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
    .map(digest);

  isValid(provided: string): boolean {
    const supplied = digest(provided);
    return this.keyDigests.some((expected) => timingSafeEqual(expected, supplied));
  }
}
