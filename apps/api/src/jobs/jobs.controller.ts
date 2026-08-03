import { Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { ApiTags } from "@nestjs/swagger";
import { Queue } from "bullmq";
import { CreateJobDto } from "./dto/create-job.dto";
import { DEMO_QUEUE } from "./queue";

@ApiTags("jobs")
@Controller("jobs")
export class JobsController {
  constructor(@InjectQueue(DEMO_QUEUE) private readonly queue: Queue) {}

  @Post()
  async enqueue(@Body() dto: CreateJobDto): Promise<{ id: string | undefined }> {
    const job = await this.queue.add("demo", { text: dto.text });
    return { id: job.id };
  }

  @Get(":id")
  async status(
    @Param("id") id: string,
  ): Promise<{ id: string | undefined; state: string; result: unknown }> {
    const job = await this.queue.getJob(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return { id: job.id, state: await job.getState(), result: job.returnvalue ?? null };
  }
}
