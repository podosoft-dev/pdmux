import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { exclusive, lockPath } from "../helpers/exclusive";

// Checks the lock that specs changing shared settings hold. Names are unique per
// run so these never wait on, or release, a lock a real spec holds.
const unique = (label: string): string => `self-test-${label}-${process.pid}-${Date.now()}`;

test("exclusive releases its locks when the body fails", async () => {
  const first = unique("first");
  const second = unique("second");
  await expect(
    exclusive([second, first], async () => {
      expect(existsSync(lockPath(first))).toBe(true);
      expect(existsSync(lockPath(second))).toBe(true);
      throw new Error("body failed");
    }),
  ).rejects.toThrow("body failed");
  expect(existsSync(lockPath(first))).toBe(false);
  expect(existsSync(lockPath(second))).toBe(false);

  // The next holder gets the lock without waiting.
  const started = Date.now();
  await exclusive(first, async () => undefined);
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("exclusive runs holders of one lock one at a time", async () => {
  const name = unique("serial");
  const events: string[] = [];
  const hold = (id: string): Promise<void> =>
    exclusive(name, async () => {
      events.push(`${id} start`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      events.push(`${id} end`);
    });
  await Promise.all([hold("a"), hold("b")]);
  expect(events.map((event) => event.split(" ")[1])).toEqual(["start", "end", "start", "end"]);
  expect(existsSync(lockPath(name))).toBe(false);
});

test("exclusive takes over a lock left by a run that was killed", async () => {
  const name = unique("stale");
  mkdirSync(lockPath(name));
  const longAgo = new Date(Date.now() - 10 * 60_000);
  utimesSync(lockPath(name), longAgo, longAgo);
  await expect(exclusive(name, async () => "acquired")).resolves.toBe("acquired");
  expect(existsSync(lockPath(name))).toBe(false);
});

test("exclusive takes over a lock whose holder exited, such as after Ctrl-C", async () => {
  const name = unique("exited");
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  mkdirSync(lockPath(name));
  writeFileSync(join(lockPath(name), "owner"), String(exited));
  const started = Date.now();
  await expect(exclusive(name, async () => "acquired")).resolves.toBe("acquired");
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(existsSync(lockPath(name))).toBe(false);
});

test("exclusive waits for a lock whose holder is still running", async () => {
  const name = unique("alive");
  mkdirSync(lockPath(name));
  writeFileSync(join(lockPath(name), "owner"), String(process.pid));
  const waiting = exclusive(name, async () => "acquired");
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(existsSync(lockPath(name))).toBe(true);
  // The holder finishes; the waiter then gets the lock.
  await rm(lockPath(name), { recursive: true, force: true });
  await expect(waiting).resolves.toBe("acquired");
});
