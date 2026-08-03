import { describe, expect, it } from "@jest/globals";
import {
  AppException,
  PROFILE_IMAGE_DIMENSIONS_INVALID,
  PROFILE_IMAGE_POLICY,
  PROFILE_IMAGE_TOO_LARGE,
  PROFILE_IMAGE_TYPE_INVALID,
} from "@podosoft/podokit-contracts";
import { validateProfileImage, type ProfileImageUpload } from "./profile-image.validation";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADAQMAAACDJEzCAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURWYzmf///129H+IAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcVCSUTzXBDTwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yMVQwOTozNzoxOSswMDowMOuehLIAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjFUMDk6Mzc6MTkrMDA6MDCawzwOAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTIxVDA5OjM3OjE5KzAwOjAwzdYd0QAAAAtJREFUCNdjYAABAAAGAAFm9MlsAAAAAElFTkSuQmCC";
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAKAAoDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnpuCtAAAf//Z";
const WEBP = "UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoCAAMAAgA0JaACdLoAA5gA/vCwN/8bx4FeS7K/1oWg+AAA";
const TOO_WIDE_PNG = "iVBORw0KGgoAAAANSUhEUgAACAEAAAABAQMAAACfGLePAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURWYzmf///129H+IAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcVCScoTk3I6QAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yMVQwOTozOTo0MCswMDowMCgv/7YAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjFUMDk6Mzk6NDArMDA6MDBZckcKAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTIxVDA5OjM5OjQwKzAwOjAwDmdm1QAAAAxJREFUGNNjYBjpAAABAgABRf+HpwAAAABJRU5ErkJggg==";

function upload(base64: string, mimetype: string, size?: number): ProfileImageUpload {
  const buffer = Buffer.from(base64, "base64");
  return { buffer, mimetype, size: size ?? buffer.length };
}

function expectAppException(action: () => void, code: string, statusCode = 400): void {
  try {
    action();
    throw new Error("Expected validation to throw");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ code, statusCode });
  }
}

describe("validateProfileImage", () => {
  const supported: Array<[string, string, "png" | "jpg" | "webp", number, number]> = [
    [PNG, "image/png", "png", 2, 3],
    [JPEG, "image/jpeg", "jpg", 10, 10],
    [WEBP, "image/webp", "webp", 2, 3],
  ];

  it.each(supported)("accepts a valid supported image", (base64, mimetype, extension, width, height) => {
    expect(validateProfileImage(upload(base64, mimetype))).toMatchObject({
      contentType: mimetype,
      extension,
      width,
      height,
    });
  });

  it("rejects a MIME type that does not match the bytes", () => {
    expectAppException(
      () => validateProfileImage(upload(PNG, "image/jpeg")),
      PROFILE_IMAGE_TYPE_INVALID,
    );
  });

  it("rejects unsupported or malformed bytes", () => {
    expectAppException(
      () => validateProfileImage(upload(Buffer.from("not an image").toString("base64"), "image/png")),
      PROFILE_IMAGE_TYPE_INVALID,
    );
  });

  it("rejects a file larger than the shared byte limit", () => {
    expectAppException(
      () => validateProfileImage(upload(PNG, "image/png", PROFILE_IMAGE_POLICY.maxBytes + 1)),
      PROFILE_IMAGE_TOO_LARGE,
      413,
    );
  });

  it("accepts arbitrary aspect ratios within the limit", () => {
    expect(validateProfileImage(upload(PNG, "image/png"))).toMatchObject({ width: 2, height: 3 });
  });

  it("rejects a dimension above 2048 pixels", () => {
    expectAppException(
      () => validateProfileImage(upload(TOO_WIDE_PNG, "image/png")),
      PROFILE_IMAGE_DIMENSIONS_INVALID,
    );
  });
});
