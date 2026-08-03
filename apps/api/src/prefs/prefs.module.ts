import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { HostsModule } from "../hosts/hosts.module";
import { PrefsController } from "./prefs.controller";
import { PrefsService } from "./prefs.service";
import { UserHostPref } from "./user-host-pref.entity";
import { UserLayout } from "./user-layout.entity";

@Module({
  imports: [TypeOrmModule.forFeature([UserLayout, UserHostPref]), HostsModule],
  controllers: [PrefsController],
  providers: [PrefsService],
  exports: [PrefsService],
})
export class PrefsModule {}
