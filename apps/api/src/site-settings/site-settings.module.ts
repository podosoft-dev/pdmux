import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AppSetting } from "../settings/app-setting.entity";
import { SiteSettingsController } from "./site-settings.controller";
import { SiteSettingsService } from "./site-settings.service";

// StorageService comes from the global StorageModule (object-storage-s3).
@Module({
  imports: [TypeOrmModule.forFeature([AppSetting])],
  controllers: [SiteSettingsController],
  providers: [SiteSettingsService],
  exports: [SiteSettingsService],
})
export class SiteSettingsModule {}
