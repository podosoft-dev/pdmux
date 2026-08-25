import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  registerUserDeletedHandler,
  runUserDeletedHandlers,
  type UserDeletedHandler,
} from "./user-delete-handlers";

describe("user deletion handlers", () => {
  const unregister: Array<() => void> = [];

  afterEach(() => {
    for (const remove of unregister.splice(0)) remove();
    mock.restore();
  });

  function register(handler: UserDeletedHandler): void {
    unregister.push(registerUserDeletedHandler(handler));
  }

  test("runs registered module cleanup with the deleted user", async () => {
    const handler: UserDeletedHandler = mock(async () => undefined);
    register(handler);
    const user = { id: "user-1", image: "/api/profile-images/avatar.png" };

    await runUserDeletedHandlers(user);

    expect(handler).toHaveBeenCalledWith(user);
  });

  test("does not fail account deletion when one cleanup rejects", async () => {
    spyOn(console, "error").mockImplementation(() => undefined);
    register(async () => {
      throw new Error("storage unavailable");
    });

    await expect(runUserDeletedHandlers({ id: "user-1" })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "Run user deletion cleanup failed",
      expect.objectContaining({ userId: "user-1", error: "storage unavailable" }),
    );
  });
});
