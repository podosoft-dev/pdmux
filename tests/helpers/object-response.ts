import { expect } from "@playwright/test";

// IN_MEMORY_READ_BYTES of @podosoft/podokit-runtime. Both object storage
// providers and the web proxy keep the Content-Length of objects up to this
// size; Bun may send larger ones chunked.
const IN_MEMORY_READ_BYTES = 2 * 1024 * 1024;

export function expectObjectLength(headers: Record<string, string>, size: number): void {
  const length = headers["content-length"];
  if (length === undefined && size > IN_MEMORY_READ_BYTES) return;
  expect(length).toBe(String(size));
}
