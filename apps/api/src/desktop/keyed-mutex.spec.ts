import { describe, expect, it } from "bun:test";
import { KeyedMutex } from "./keyed-mutex";

/** A promise the test settles by hand, standing in for a slow write. */
function gate(): { promise: Promise<void>; open: () => void; fail: (error: Error) => void } {
  let open!: () => void; let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
  return { promise, open, fail };
}
/** Whether a promise has settled once every queued callback has run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  return done;
}

describe("[TC-PDDESKTOP-015] keyed workspace lock", () => {
  it("[TC-PDDESKTOP-015] runs work under one key one at a time, in arrival order", async () => {
    const lock = new KeyedMutex();
    const order: string[] = [];
    const slow = gate();
    const first = lock.run(["prefs:a"], async () => { order.push("first:start"); await slow.promise; order.push("first:end"); });
    const second = lock.run(["prefs:a"], async () => { order.push("second"); });
    expect(await settled(second)).toBe(false);
    expect(order).toEqual(["first:start"]);
    slow.open();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(lock.size).toBe(0);
  });

  it("[TC-PDDESKTOP-015] does not hold one user's write behind another user's slow write", async () => {
    const lock = new KeyedMutex();
    const slow = gate();
    const userA = lock.run(["prefs:a"], () => slow.promise);
    const userB = lock.run(["prefs:b"], async () => "saved");
    expect(await settled(userB)).toBe(true);
    expect(await userB).toBe("saved");
    expect(await settled(userA)).toBe(false);
    expect(lock.size).toBe(1);
    slow.open(); await userA;
    expect(lock.size).toBe(0);
  });

  it("[TC-PDDESKTOP-015] releases the key when the work throws", async () => {
    const lock = new KeyedMutex();
    const failing = gate();
    const first = lock.run(["hosts:org"], () => failing.promise);
    const second = lock.run(["hosts:org"], async () => "after");
    failing.fail(new Error("write failed"));
    await expect(first).rejects.toThrow("write failed");
    expect(await second).toBe("after");
    expect(lock.size).toBe(0);
  });

  it("[TC-PDDESKTOP-015] keeps no entry for a key once its work completes", async () => {
    const lock = new KeyedMutex();
    await Promise.all(Array.from({ length: 100 }, (_, index) => lock.run([`prefs:user-${index % 7}`, `hosts:org-${index % 3}`], async () => index)));
    expect(lock.size).toBe(0);
    const release = await lock.acquire(["prefs:a", "prefs:a"]);
    expect(lock.size).toBe(1);
    release(); release();
    expect(lock.size).toBe(0);
  });

  it("[TC-PDDESKTOP-015] takes several keys without deadlocking callers that share some of them", async () => {
    const lock = new KeyedMutex();
    const held = await lock.acquire(["prefs:a"]);
    const sync = lock.acquire(["prefs:a", "hosts:org"]);
    const reversed = lock.acquire(["hosts:org", "prefs:a"]);
    const otherUser = lock.acquire(["prefs:b"]);
    expect(await settled(sync)).toBe(false);
    expect(await settled(otherUser)).toBe(true);
    held();
    (await sync)();
    (await reversed)();
    (await otherUser)();
    expect(lock.size).toBe(0);
  });
});
