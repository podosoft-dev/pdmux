import { Global, Module } from "@nestjs/common";
import { CacheController } from "./cache.controller";
import { RedisService } from "./redis.service";

// Global so any module can inject RedisService (cache, pub/sub, etc.).
@Global()
@Module({
  controllers: [CacheController],
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
