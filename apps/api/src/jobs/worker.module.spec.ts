import { describe, expect, it } from "bun:test";
import type { Processor } from "bullmq";
import { DEMO_QUEUE } from "./queue";
import { collectWorkers, type WorkerDefinition } from "./worker.module";

const processor: Processor = async () => undefined;

describe("worker definitions", () => {
  it("adds the application's queues after PodoKit's and releases them last first", async () => {
    const released: string[] = [];
    const collected = await collectWorkers(async (setup) => {
      setup.onClose(() => { released.push("database"); });
      setup.onClose(async () => { released.push("cache"); });
      return [{ queue: "reports", processor, options: { concurrency: 2 } }];
    });
    expect(collected.definitions.map((definition) => definition.queue)).toEqual([DEMO_QUEUE, "reports"]);
    expect(collected.definitions[1]?.options).toEqual({ concurrency: 2 });
    await collected.release();
    expect(released).toEqual(["cache", "database"]);
  });

  it("refuses two workers for one queue and releases what was opened", async () => {
    const released: string[] = [];
    const duplicate: WorkerDefinition = { queue: DEMO_QUEUE, processor };
    await expect(collectWorkers(async (setup) => {
      setup.onClose(() => { released.push("database"); });
      return [duplicate];
    })).rejects.toThrow(`More than one worker for queue ${DEMO_QUEUE}`);
    expect(released).toEqual(["database"]);
  });

  it("releases what was opened when the application setup fails", async () => {
    const released: string[] = [];
    await expect(collectWorkers(async (setup) => {
      setup.onClose(() => { released.push("database"); });
      throw new Error("no database");
    })).rejects.toThrow("no database");
    expect(released).toEqual(["database"]);
  });
});
