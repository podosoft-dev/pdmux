import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  AppException,
  PROFILE_IMAGE_POLICY,
  PROFILE_IMAGE_TOO_LARGE,
} from "@podosoft/podokit-contracts";
import type { Observable } from "rxjs";

const ProfileImageFileInterceptor = FileInterceptor("file", {
  limits: { fileSize: PROFILE_IMAGE_POLICY.maxBytes },
});

/** Preserve a stable error code when Multer rejects an oversized request. */
@Injectable()
export class ProfileImageUploadInterceptor extends ProfileImageFileInterceptor {
  override async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return await super.intercept(context, next);
    } catch (error: unknown) {
      if (error instanceof PayloadTooLargeException) {
        throw new AppException(
          PROFILE_IMAGE_TOO_LARGE,
          "Profile image must be 2 MB or smaller.",
          413,
        );
      }
      throw error;
    }
  }
}
