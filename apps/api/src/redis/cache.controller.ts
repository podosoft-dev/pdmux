import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { RedisService } from "./redis.service";
import { SetCacheDto } from "./dto/set-cache.dto";

@ApiTags("cache")
@Controller("cache")
export class CacheController {
  constructor(private readonly redis: RedisService) {}

  @Put(":key")
  async put(@Param("key") key: string, @Body() dto: SetCacheDto): Promise<{ key: string }> {
    await this.redis.set(key, dto.value, dto.ttl);
    return { key };
  }

  @Get(":key")
  async get(@Param("key") key: string): Promise<{ key: string; value: string | null }> {
    return { key, value: await this.redis.get(key) };
  }
}
