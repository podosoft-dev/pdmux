/// <reference types="multer" />
import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import { Public, Session, type UserSession } from "@thallesp/nestjs-better-auth";
import {
  AppException,
  PROFILE_IMAGE_REQUIRED,
  type ProfileImageResponse,
} from "@podosoft/podokit-contracts";
import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import { ProfileImageService } from "./profile-image.service";
import { ProfileImageUploadInterceptor } from "./profile-image-upload.interceptor";

@ApiTags("account")
@Controller()
export class ProfileImageController {
  constructor(private readonly profileImages: ProfileImageService) {}

  @Post("account/profile-image")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(ProfileImageUploadInterceptor)
  async upload(
    @Session() session: UserSession,
    @Req() req: Request,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ProfileImageResponse> {
    if (!file) {
      throw new AppException(
        PROFILE_IMAGE_REQUIRED,
        "A profile image file is required.",
      );
    }
    return this.profileImages.upload(
      session.user.image ?? null,
      file,
      fromNodeHeaders(req.headers),
    );
  }

  @Delete("account/profile-image")
  async remove(
    @Session() session: UserSession,
    @Req() req: Request,
  ): Promise<ProfileImageResponse> {
    return this.profileImages.remove(
      session.user.image ?? null,
      fromNodeHeaders(req.headers),
    );
  }

  @Public()
  @Get("profile-images/:fileName")
  async get(
    @Param("fileName") fileName: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const image = await this.profileImages.get(fileName);
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return new StreamableFile(image.body, { type: image.contentType });
  }
}
