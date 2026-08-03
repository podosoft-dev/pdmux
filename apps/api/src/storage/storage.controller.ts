import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { StorageService } from "./storage.service";
import { PutObjectDto } from "./dto/put-object.dto";

// Demo endpoints — replace with your own. See the file-upload module for
// multipart uploads built on this service.
@ApiTags("storage")
@Controller("storage")
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Put(":key")
  async put(@Param("key") key: string, @Body() dto: PutObjectDto): Promise<{ key: string }> {
    await this.storage.put(key, dto.content, "text/plain");
    return { key };
  }

  @Get(":key")
  async get(@Param("key") key: string): Promise<{ key: string; content: string }> {
    const buffer = await this.storage.get(key);
    return { key, content: buffer.toString("utf8") };
  }

  @Get(":key/presigned")
  async presigned(@Param("key") key: string): Promise<{ url: string }> {
    return { url: await this.storage.presignedGetUrl(key) };
  }
}
