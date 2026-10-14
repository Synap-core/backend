/**
 * A job that starts before apps/api fills the runner slot (workers start
 * first) must not complete as a silent no-op: it waits for the runner, and if
 * none arrives it FAILS (visible in pg-boss) instead of reading as done.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleEntityMediaCopy,
  registerEntityMediaCopyRunner,
  resetEntityMediaCopyRunnerForTests,
} from "../entity-media-copy-worker.js";

const job = (data: unknown) => ({ id: "j1", name: "q", data }) as never;

afterEach(() => resetEntityMediaCopyRunnerForTests());

describe("handleEntityMediaCopy before the runner is registered", () => {
  it("waits for the runner and then runs the job", async () => {
    const runner = vi.fn(async () => ({ status: "copied" }));
    const pending = handleEntityMediaCopy(job({ entityId: "e1" }), {
      waitMs: 5_000,
    });
    registerEntityMediaCopyRunner(runner);
    await pending;
    expect(runner).toHaveBeenCalledWith({ entityId: "e1" });
  });

  it("no runner within the wait: the job fails, it never reads as done", async () => {
    await expect(
      handleEntityMediaCopy(job({ entityId: "e1" }), { waitMs: 10 })
    ).rejects.toThrow(/did not run/);
  });

  it("a registered runner runs at once", async () => {
    const runner = vi.fn(async () => null);
    registerEntityMediaCopyRunner(runner);
    await handleEntityMediaCopy(job({ entityId: "e2" }), { waitMs: 0 });
    expect(runner).toHaveBeenCalledWith({ entityId: "e2" });
  });
});
