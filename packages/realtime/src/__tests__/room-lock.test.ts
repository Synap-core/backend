import { describe, expect, it } from "vitest";
import { RoomLockTimeoutError, withRoomLock } from "../room-lock.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withRoomLock is bounded", () => {
  it("a holder that never finishes loses the lock: the next waiter proceeds", async () => {
    const stuck = withRoomLock("room-a", () => new Promise<void>(() => {}), {
      maxHoldMs: 30,
    });
    const next = withRoomLock("room-a", async () => "ran", { maxHoldMs: 30 });
    await expect(stuck).rejects.toBeInstanceOf(RoomLockTimeoutError);
    await expect(next).resolves.toBe("ran");
  });

  it("the timeout says the outcome is unknown and retry is safe", async () => {
    await expect(
      withRoomLock("room-b", () => tick(200), { maxHoldMs: 10 })
    ).rejects.toThrow(/may or may not have landed: retry is safe/);
  });

  it("CONTROL: holders inside the bound still run one at a time, in order", async () => {
    const order: string[] = [];
    await Promise.all(
      ["1", "2", "3"].map((n) =>
        withRoomLock("room-c", async () => {
          order.push(`start-${n}`);
          await tick(5);
          order.push(`end-${n}`);
        })
      )
    );
    expect(order).toEqual([
      "start-1",
      "end-1",
      "start-2",
      "end-2",
      "start-3",
      "end-3",
    ]);
  });
});
