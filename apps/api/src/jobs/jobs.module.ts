import { AppException } from "@podosoft/podokit-contracts";
import { Elysia, t } from "elysia";
import type { AppPlugin, PodokitModule, ServiceKey } from "../core/services";
import { DEMO_QUEUE } from "./queue";
import { BullMqJobProvider, type JobProvider, LocalJobProvider } from "../runtime/jobs";
import { runtimeProviders } from "../runtime/providers";
import { processDemoJob } from "./demo.processor";

export const JOBS = Symbol("jobs") as ServiceKey<JobProvider>;

const jobsPlugin: AppPlugin = ({ services }) => {
  const jobs = services.resolve(JOBS);
  return new Elysia({ name: "podokit.jobs" })
    .post("/jobs", async ({ body, set }) => {
      const job = await jobs.enqueue(DEMO_QUEUE, "demo", { text: body.text });
      set.status = 201;
      return { id: job.id };
    }, {
      body: t.Object({ text: t.String({ minLength: 1 }) }),
      detail: { tags: ["jobs"], summary: "Enqueue a job" },
    })
    .get("/jobs/:id", async ({ params }) => {
      const job = await jobs.get(DEMO_QUEUE, params.id);
      if (!job) throw new AppException("JOB_NOT_FOUND", `Job ${params.id} not found`, 404);
      return job;
    }, {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      detail: { tags: ["jobs"], summary: "Read job status" },
    });
};

export const jobsModule: PodokitModule = {
  name: "bullmq",
  configure: (_env, services): void => {
    const jobs: JobProvider = runtimeProviders().jobs === "local"
      ? new LocalJobProvider()
      : new BullMqJobProvider();
    jobs.register(DEMO_QUEUE, "demo", processDemoJob);
    services.register(JOBS, jobs, () => jobs.close());
  },
  plugin: jobsPlugin,
};
