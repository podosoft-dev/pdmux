import {
  AppException,
  PROFILE_IMAGE_DIMENSIONS_INVALID,
  PROFILE_IMAGE_POLICY,
  PROFILE_IMAGE_TOO_LARGE,
  PROFILE_IMAGE_TYPE_INVALID,
  type ProfileImageMimeType,
} from "@podosoft/podokit-contracts";
import { imageSize } from "image-size";

export interface ProfileImageUpload {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export interface ProfileImageMetadata {
  contentType: ProfileImageMimeType;
  extension: "jpg" | "png" | "webp";
  width: number;
  height: number;
}

const DETECTED_TYPES: Record<string, Pick<ProfileImageMetadata, "contentType" | "extension">> = {
  jpg: { contentType: "image/jpeg", extension: "jpg" },
  png: { contentType: "image/png", extension: "png" },
  webp: { contentType: "image/webp", extension: "webp" },
};

/** Inspect image bytes instead of trusting the uploaded filename or MIME type. */
export function validateProfileImage(file: ProfileImageUpload): ProfileImageMetadata {
  if (Math.max(file.size, file.buffer.length) > PROFILE_IMAGE_POLICY.maxBytes) {
    throw new AppException(
      PROFILE_IMAGE_TOO_LARGE,
      "Profile image must be 2 MB or smaller.",
      413,
    );
  }

  let dimensions: ReturnType<typeof imageSize>;
  try {
    dimensions = imageSize(file.buffer);
  } catch {
    throw new AppException(
      PROFILE_IMAGE_TYPE_INVALID,
      "Profile image must be a valid PNG, JPEG, or WebP file.",
    );
  }

  const detected = dimensions.type ? DETECTED_TYPES[dimensions.type] : undefined;
  if (!detected || detected.contentType !== file.mimetype) {
    throw new AppException(
      PROFILE_IMAGE_TYPE_INVALID,
      "Profile image must be a valid PNG, JPEG, or WebP file.",
    );
  }
  if (
    dimensions.width === undefined
    || dimensions.height === undefined
    || dimensions.width > PROFILE_IMAGE_POLICY.maxWidth
    || dimensions.height > PROFILE_IMAGE_POLICY.maxHeight
  ) {
    throw new AppException(
      PROFILE_IMAGE_DIMENSIONS_INVALID,
      "Profile image dimensions must not exceed 2048 by 2048 pixels.",
    );
  }

  return {
    ...detected,
    width: dimensions.width,
    height: dimensions.height,
  };
}
