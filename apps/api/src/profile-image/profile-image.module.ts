import { Module } from "@nestjs/common";
import { ProfileImageController } from "./profile-image.controller";
import { ProfileImageService } from "./profile-image.service";

@Module({
  controllers: [ProfileImageController],
  providers: [ProfileImageService],
})
export class ProfileImageModule {}
