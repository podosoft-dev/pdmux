import { AppException } from "@podosoft/podokit-contracts";
import { JOBS } from "@podosoft/podokit-runtime";
import { Elysia, t } from "elysia";
import { PROVIDERS } from "../config/providers";
import { DATABASE, type AppPlugin, type PodokitModule } from "../core/services";
import { LocalJobQueue } from "./local-job.queue";

const localJobsPlugin: AppPlugin = ({ services }) => {
  if (PROVIDERS.jobs !== "local") return new Elysia({ name: "podokit.jobs-local.inactive" });
  const queue = services.resolve(JOBS);
  return new Elysia({ name: "podokit.jobs-local" })
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
      return { id: job.id, state: job.status, error: job.error ?? null };
    }, {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      detail: { tags: ["jobs"], summary: "Read job status" },
    });
};

export const jobsLocalModule: PodokitModule = {
  name: "jobs-local",
  configure: (_env, services): void => {
    if (PROVIDERS.jobs !== "local") return;
    const queue = new LocalJobQueue(services.resolve(DATABASE).sql, {
      pollIntervalMs: Number(process.env.LOCAL_JOBS_POLL_INTERVAL_MS ?? 250),
    });
    void queue.process("demo", () => undefined);
    services.register(JOBS, queue, () => queue.close());
    services.supervise("jobs", { connect: () => queue.start() });
  },
  plugin: localJobsPlugin,
};
