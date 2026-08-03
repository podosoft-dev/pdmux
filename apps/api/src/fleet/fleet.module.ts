import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { FleetScopeController } from "./fleet-scope.controller";
import { FleetSetting } from "./fleet-setting.entity";
import { FleetSettingsController } from "./fleet-settings.controller";
import { FleetSettingsService } from "./fleet-settings.service";

/** Organization-level knobs shared by every other fleet module. */
@Module({
  imports: [TypeOrmModule.forFeature([FleetSetting])],
  controllers: [FleetScopeController, FleetSettingsController],
  providers: [FleetSettingsService],
  exports: [FleetSettingsService],
})
export class FleetModule {}
