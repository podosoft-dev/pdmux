import { Module } from "@nestjs/common";
import { SettingsModule } from "../settings/settings.module";
import { AccountController } from "./account.controller";

@Module({ imports: [SettingsModule], controllers: [AccountController] })
export class AccountModule {}
