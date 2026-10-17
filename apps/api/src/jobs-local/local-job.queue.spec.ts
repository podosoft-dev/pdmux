import { afterEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { LocalJobQueue, nextScheduledTime, type ScheduleTimer } from "./local-job.queue";

let sql: SQL | undefined;

afterEach(async () => {
  await sql?.close();
  sql = undefined;
});

describe("local job queue", () => {
  it("persists and processes a job", async () => {
    sql = new SQL(":memory:");
    const queue = new LocalJobQueue(sql, { pollIntervalMs: 10 });
    const payloads: unknown[] = [];
    await queue.process("demo", (payload) => { payloads.push(payload); });
    const job = await queue.enqueue("demo", { text: "hello" });
    expect(await queue.runOnce()).toBe(true);
    expect(payloads).toEqual([{ text: "hello" }]);
    await expect(queue.get(job.id)).resolves.toMatchObject({
      status: "completed",
      attempts: 1,
    });
    queue.close();
  });

  it("creates its table on a later start after the database was unreachable", async () => {
    const database = new SQL(":memory:");
    sql = database;
    let unreachable = true;
    const flaky = new Proxy(database, {
      apply: (target, thisArg, args) =>
        unreachable
          ? Promise.reject(new Error("Connection refused"))
          : Reflect.apply(target, thisArg, args),
    });
    const queue = new LocalJobQueue(flaky, { pollIntervalMs: 10 });
    const payloads: unknown[] = [];
    await queue.process("demo", (payload) => { payloads.push(payload); });

    await expect(queue.start()).rejects.toThrow("Connection refused");
    unreachable = false;
    await queue.start();
    await queue.enqueue("demo", { text: "after outage" });
    for (let waited = 0; payloads.length === 0 && waited < 1_000; waited += 10) await Bun.sleep(10);
    expect(payloads).toEqual([{ text: "after outage" }]);
    queue.close();
  });

  it("retries failures and records the final error", async () => {
    sql = new SQL(":memory:");
    let now = 1_000;
    const queue = new LocalJobQueue(sql, { pollIntervalMs: 10, now: () => now });
    await queue.process("fail", () => { throw new Error("expected failure"); });
    const job = await queue.enqueue("fail", {}, { attempts: 2 });
    expect(await queue.runOnce()).toBe(true);
    expect((await queue.get(job.id))?.status).toBe("waiting");
    now += 10;
    expect(await queue.runOnce()).toBe(true);
    await expect(queue.get(job.id)).resolves.toMatchObject({
      status: "failed",
      attempts: 2,
      error: "expected failure",
    });
    queue.close();
  });
});

/** A clock and timer the test moves by hand. */
function manualTime(start: number): { now: () => number; timer: ScheduleTimer; advance: (to: number) => void; waiting: () => number } {
  let now = start;
  const timers: Array<{ at: number; task: () => void; done: boolean }> = [];
  return {
    now: () => now,
    timer: {
      after: (delayMs, task) => {
        const entry = { at: now + delayMs, task, done: false };
        timers.push(entry);
        return () => { entry.done = true; };
      },
    },
    advance: (to) => {
      for (;;) {
        const due = timers.filter((entry) => !entry.done && entry.at <= to).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.done = true;
        now = due.at;
        due.task();
      }
      now = to;
    },
    waiting: () => timers.filter((entry) => !entry.done).length,
  };
}

async function scheduledJobs(database: SQL): Promise<string[]> {
  // Scheduled jobs are added without waiting; let those inserts finish.
  await Bun.sleep(5);
  const rows = await database<Array<{ id: string }>>`SELECT "id" FROM "podokit_job" ORDER BY "createdAt", "id"`;
  return rows.map((row) => row.id);
}

describe("local job schedules", () => {
  it("adds one job for each time of an interval and keeps going", async () => {
    sql = new SQL(":memory:");
    const time = manualTime(10_500);
    const queue = new LocalJobQueue(sql, { pollIntervalMs: 60_000, now: time.now, timer: time.timer });
    await queue.schedule("nightly", "report", { scope: "all" }, { everyMs: 1_000 });
    await queue.start();
    time.advance(11_000);
    expect(await scheduledJobs(sql)).toEqual(["report:schedule:nightly:11000"]);
    time.advance(13_200);
    expect(await scheduledJobs(sql)).toEqual([
      "report:schedule:nightly:11000",
      "report:schedule:nightly:12000",
      "report:schedule:nightly:13000",
    ]);
    await expect(queue.get("report:schedule:nightly:12000")).resolves.toMatchObject({ name: "report", status: "waiting" });
    queue.close();
    expect(time.waiting()).toBe(0);
  });

  it("replaces a schedule with the same id and stops one on unschedule", async () => {
    sql = new SQL(":memory:");
    const time = manualTime(0);
    const queue = new LocalJobQueue(sql, { pollIntervalMs: 60_000, now: time.now, timer: time.timer });
    await queue.start();
    await queue.schedule("sync", "sync", {}, { everyMs: 1_000 });
    await queue.schedule("sync", "sync", {}, { everyMs: 5_000 });
    time.advance(5_000);
    expect(await scheduledJobs(sql)).toEqual(["sync:schedule:sync:5000"]);
    await queue.unschedule("sync");
    time.advance(20_000);
    expect(await scheduledJobs(sql)).toEqual(["sync:schedule:sync:5000"]);
    queue.close();
  });

  it("reads cron expressions in the schedule's time zone, UTC by default", () => {
    const after = Date.UTC(2026, 0, 1, 0, 0);
    expect(nextScheduledTime({ cron: "0 3 * * *" }, after)).toBe(Date.UTC(2026, 0, 1, 3, 0));
    expect(nextScheduledTime({ cron: "0 3 * * *", timezone: "Asia/Seoul" }, after)).toBe(Date.UTC(2026, 0, 1, 18, 0));
    expect(nextScheduledTime({ everyMs: 60_000 }, after + 1)).toBe(after + 60_000);
  });

  it("rejects an invalid schedule before it is kept", async () => {
    sql = new SQL(":memory:");
    const queue = new LocalJobQueue(sql);
    await expect(queue.schedule("bad", "report", {}, { cron: "61 * * * *" })).rejects.toThrow();
    await expect(queue.schedule("bad", "report", {}, { cron: "0 3 * * *", timezone: "Mars/Olympus" })).rejects.toThrow();
    await expect(queue.schedule("bad", "report", {}, { everyMs: 10 })).rejects.toThrow("at least 1000");
    await expect(queue.schedule("bad", "report", {}, { everyMs: 1_000 }, { keepCompleted: -1 })).rejects.toThrow(
      "keepCompleted must be a whole number of at least 0",
    );
    queue.close();
  });
});

/** Moves the clock to each time and runs the job the schedule added then. */
async function runScheduled(queue: LocalJobQueue, time: ReturnType<typeof manualTime>, times: number[]): Promise<void> {
  for (const at of times) {
    time.advance(at);
    // The schedule adds its job without waiting; let the insert finish.
    await Bun.sleep(1);
    expect(await queue.runOnce()).toBe(true);
  }
}

async function finishedJobs(database: SQL): Promise<string[]> {
  const rows = await database<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "podokit_job" ORDER BY "updatedAt", "id"
  `;
  return rows.map((row) => `${row.id} ${row.status}`);
}

describe("local job schedule cleanup", () => {
  it("keeps the newest finished jobs of a scheduled run's name up to the schedule's limits", async () => {
    sql = new SQL(":memory:");
    const time = manualTime(0);
    const queue = new LocalJobQueue(sql, { pollIntervalMs: 60_000, now: time.now, timer: time.timer });
    await queue.process("report", (_payload, job) => {
      if (job.id.endsWith(":3000") || job.id.endsWith(":5000")) throw new Error("expected failure");
    });
    await queue.process("other", () => undefined);
    const other = await queue.enqueue("other", {});
    const adHoc = await queue.enqueue("report", {});
    while (await queue.runOnce());
    await queue.schedule("tick", "report", {}, { everyMs: 1_000 }, { keepCompleted: 2, keepFailed: 1 });
    await queue.start();
    await Bun.sleep(5);

    await runScheduled(queue, time, [1_000, 2_000, 3_000, 4_000, 5_000, 6_000]);

    // As BullMQ trims a queue: the job enqueue() added goes too, another name's stays.
    expect(await finishedJobs(sql)).toEqual([
      `${other.id} completed`,
      "report:schedule:tick:4000 completed",
      "report:schedule:tick:5000 failed",
      "report:schedule:tick:6000 completed",
    ]);
    expect(await queue.get(adHoc.id)).toBeNull();
    queue.close();
  });

  it("removes only the run itself when a limit is 0", async () => {
    sql = new SQL(":memory:");
    const time = manualTime(0);
    const queue = new LocalJobQueue(sql, { pollIntervalMs: 60_000, now: time.now, timer: time.timer });
    await queue.process("report", (_payload, job) => {
      if (job.id.endsWith(":2000")) throw new Error("expected failure");
    });
    const adHoc = await queue.enqueue("report", {});
    while (await queue.runOnce());
    await queue.schedule("tick", "report", {}, { everyMs: 1_000 }, { keepCompleted: 0, keepFailed: 0 });
    await queue.start();
    await Bun.sleep(5);

    await runScheduled(queue, time, [1_000, 2_000, 3_000]);

    expect(await finishedJobs(sql)).toEqual([`${adHoc.id} completed`]);
    queue.close();
  });

  it("keeps 100 completed runs of a schedule by default", async () => {
    sql = new SQL(":memory:");
    const time = manualTime(0);
    const queue = new LocalJobQueue(sql, { pollIntervalMs: 60_000, now: time.now, timer: time.timer });
    await queue.process("report", () => undefined);
    await queue.schedule("tick", "report", {}, { everyMs: 1_000 });
    await queue.start();
    await Bun.sleep(5);

    await runScheduled(queue, time, Array.from({ length: 105 }, (_, index) => (index + 1) * 1_000));

    const kept = await finishedJobs(sql);
    expect(kept).toHaveLength(100);
    expect(kept[0]).toBe("report:schedule:tick:6000 completed");
    expect(kept.at(-1)).toBe("report:schedule:tick:105000 completed");
    queue.close();
  });
});
