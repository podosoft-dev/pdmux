import { AppException } from "@podosoft/podokit-contracts";
import { Queue } from "bullmq";
import { Elysia, t } from "elysia";
import type { AppPlugin, PodokitModule, ServiceKey } from "../core/services";
import { DEMO_QUEUE, redisConnection } from "./queue";

export const JOB_QUEUE = Symbol("job-queue") as ServiceKey<Queue>;

const jobsPlugin: AppPlugin = ({ services }) => {
  const queue = services.resolve(JOB_QUEUE);
  return new Elysia({ name: "podokit.jobs" })
    .post("/jobs", async ({ body, set }) => {
      const job = await queue.add("demo", { text: body.text });
      set.status = 201;
      return { id: job.id };
    }, {
      body: t.Object({ text: t.String({ minLength: 1 }) }),
      detail: { tags: ["jobs"], summary: "Enqueue a job" },
    })
    .get("/jobs/:id", async ({ params }) => {
      const job = await queue.getJob(params.id);
      if (!job) throw new AppException("JOB_NOT_FOUND", `Job ${params.id} not found`, 404);
      return { id: job.id, state: await job.getState(), result: job.returnvalue ?? null };
    }, {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      detail: { tags: ["jobs"], summary: "Read job status" },
    });
};

export const jobsModule: PodokitModule = {
  name: "bullmq",
  configure: (_env, services): void => {
    const queue = new Queue(DEMO_QUEUE, { connection: redisConnection() });
    services.register(JOB_QUEUE, queue, () => queue.close());
  },
  plugin: jobsPlugin,
};
