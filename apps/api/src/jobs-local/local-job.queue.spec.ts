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
    queue.close();
  });
});
