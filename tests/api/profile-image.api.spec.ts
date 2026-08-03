import { expect, test } from "@playwright/test";
import { ADMIN } from "../helpers/accounts";

const base = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const origin = { origin: base };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADAQMAAACDJEzCAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURWYzmf///129H+IAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcVCSUTzXBDTwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yMVQwOTozNzoxOSswMDowMOuehLIAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjFUMDk6Mzc6MTkrMDA6MDCawzwOAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTIxVDA5OjM3OjE5KzAwOjAwzdYd0QAAAAtJREFUCNdjYAABAAAGAAFm9MlsAAAAAElFTkSuQmCC",
  "base64",
);
const TOO_WIDE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAACAEAAAABAQMAAACfGLePAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURWYzmf///129H+IAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcVCScoTk3I6QAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yMVQwOTozOTo0MCswMDowMCgv/7YAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjFUMDk6Mzk6NDArMDA6MDBZckcKAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTIxVDA5OjM5OjQwKzAwOjAwDmdm1QAAAAxJREFUGNNjYBjpAAABAgABRf+HpwAAAABJRU5ErkJggg==",
  "base64",
);

async function adminContext(playwright: import("@playwright/test").PlaywrightWorkerArgs["playwright"]) {
  const context = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  await context.post("/api/auth/sign-in/email", {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  return context;
}

test("profile image upload requires authentication", async ({ playwright }) => {
  const anonymous = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: origin });
  const response = await anonymous.post("/api/account/profile-image", {
    multipart: { file: { name: "avatar.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(response.status()).toBe(401);
  await anonymous.dispose();
});

test("profile image upload, replacement, public read, and removal", async ({ playwright }) => {
  const admin = await adminContext(playwright);
  await admin.delete("/api/account/profile-image");

  const first = await admin.post("/api/account/profile-image", {
    multipart: { file: { name: "avatar.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(first.status()).toBe(201);
  const firstBody = await first.json() as { image: string };
  expect(firstBody.image).toMatch(/^\/api\/profile-images\/[0-9a-f-]+\.png$/);

  const sessionAfterUpload = await (await admin.get("/api/auth/get-session")).json() as {
    user: { image?: string | null };
  };
  expect(sessionAfterUpload.user.image).toBe(firstBody.image);
  const firstImage = await admin.get(firstBody.image);
  expect(firstImage.ok()).toBeTruthy();
  expect(firstImage.headers()["content-type"]).toContain("image/png");
  expect(firstImage.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");

  const replacement = await admin.post("/api/account/profile-image", {
    multipart: { file: { name: "replacement.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(replacement.status()).toBe(201);
  const replacementBody = await replacement.json() as { image: string };
  expect(replacementBody.image).not.toBe(firstBody.image);
  expect((await admin.get(firstBody.image)).status()).toBe(404);

  const removed = await admin.delete("/api/account/profile-image");
  expect(await removed.json()).toEqual({ image: null });
  expect((await admin.get(replacementBody.image)).status()).toBe(404);
  const sessionAfterRemoval = await (await admin.get("/api/auth/get-session")).json() as {
    user: { image?: string | null };
  };
  expect(sessionAfterRemoval.user.image).toBeNull();
  await admin.dispose();
});

test("profile image upload returns stable validation errors", async ({ playwright }) => {
  const admin = await adminContext(playwright);
  const invalidType = await admin.post("/api/account/profile-image", {
    multipart: { file: { name: "avatar.png", mimeType: "image/png", buffer: Buffer.from("not an image") } },
  });
  expect(invalidType.status()).toBe(400);
  expect((await invalidType.json()).error.code).toBe("PROFILE_IMAGE_TYPE_INVALID");

  const tooWide = await admin.post("/api/account/profile-image", {
    multipart: { file: { name: "wide.png", mimeType: "image/png", buffer: TOO_WIDE_PNG } },
  });
  expect(tooWide.status()).toBe(400);
  expect((await tooWide.json()).error.code).toBe("PROFILE_IMAGE_DIMENSIONS_INVALID");

  const tooLarge = await admin.post("/api/account/profile-image", {
    multipart: {
      file: {
        name: "large.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
      },
    },
  });
  expect(tooLarge.status()).toBe(413);
  expect((await tooLarge.json()).error.code).toBe("PROFILE_IMAGE_TOO_LARGE");
  await admin.dispose();
});
