import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthConfigRow } from "./auth-config.entity";
import { AuthConfigService } from "./auth-config.service";
import { AuthConfigController } from "./auth-config.controller";

@Module({
  imports: [TypeOrmModule.forFeature([AuthConfigRow])],
  controllers: [AuthConfigController],
  providers: [AuthConfigService],
})
export class AuthConfigModule {}
