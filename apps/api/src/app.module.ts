import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { validateEnv } from "./config/env.validation";
import { dataSourceOptions } from "./database/data-source";
import { HealthModule } from "./health/health.module";
import { extensionImports, extensionProviders } from "./app.extensions";
// podokit:begin:imports
import { APP_GUARD } from "@nestjs/core";
import { AuthModule, AuthGuard } from "@thallesp/nestjs-better-auth";
import { authRuntime } from "./auth/auth-provider";
import { AccountModule } from "./account/account.module";
import { AuthConfigModule } from "./auth-config/auth-config.module";
import { TwoFactorRequiredGuard } from "./auth/two-factor-required.guard";
import { StorageModule } from "./storage/storage.module";
import { SiteSettingsModule } from "./site-settings/site-settings.module";
import { ProfileImageModule } from "./profile-image/profile-image.module";
import { AuditModule } from "./audit/audit.module";
import { ApiKeyModule } from "./api-key/api-key.module";
import { RedisModule } from "./redis/redis.module";
import { EventsModule } from "./events/events.module";
import { JobsModule } from "./jobs/jobs.module";
import { RateLimitModule } from "./rate-limit/rate-limit.module";
import { LoggingModule } from "./logging/logging.module";
// podokit:end:imports

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRoot(dataSourceOptions),
    HealthModule,
    // podokit:begin:module-imports
    AuthModule.forRoot(authRuntime),
    AccountModule,
    AuthConfigModule,
    StorageModule,
    SiteSettingsModule,
    ProfileImageModule,
    AuditModule,
    ApiKeyModule,
    RedisModule,
    EventsModule,
    JobsModule,
    RateLimitModule,
    LoggingModule,
    // podokit:end:module-imports
    ...extensionImports,
  ],
  providers: [
    // podokit:begin:providers
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TwoFactorRequiredGuard },
    // podokit:end:providers
    ...extensionProviders,
  ],
})
export class AppModule {}
