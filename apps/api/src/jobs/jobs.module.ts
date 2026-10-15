import { AppException } from "@podosoft/podokit-contracts";
import { JOBS } from "@podosoft/podokit-runtime";
import { Elysia, t } from "elysia";
import { PROVIDERS } from "../config/providers";
import type { AppPlugin, PodokitModule } from "../core/services";
import { BullMqJobQueue } from "./bullmq-job.queue";

const jobsPlugin: AppPlugin = ({ services }) => {
  if (PROVIDERS.jobs !== "bullmq") return new Elysia({ name: "podokit.jobs.inactive" });
  const queue = services.resolve(JOBS);
  return new Elysia({ name: "podokit.jobs" })
    .post("/jobs", async ({ body, set }) => {
      const job = await queue.enqueue("demo", { text: body.text });
      set.status = 201;
      return { id: job.id };
    }, {
      body: t.Object({ text: t.String({ minLength: 1 }) }),
      detail: { tags: ["jobs"], summary: "Enqueue a job" },
    })
    .get("/jobs/:id", async ({ params }) => {
      const job = await queue.get(params.id);
      if (!job) throw new AppException("JOB_NOT_FOUND", `Job ${params.id} not found`, 404);
      return { id: job.id, state: job.status, result: job.result ?? null };
    }, {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      detail: { tags: ["jobs"], summary: "Read job status" },
    });
};

export const jobsModule: PodokitModule = {
  name: "bullmq",
  configure: (_env, services): void => {
    if (PROVIDERS.jobs !== "bullmq") return;
    const queue = new BullMqJobQueue();
    services.register(JOBS, queue, () => queue.close());
  },
  plugin: jobsPlugin,
};
