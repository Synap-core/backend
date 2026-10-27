/**
 * The dev-loop job (a merged PR the pod must act on) never completes as a
 * silent no-op: before apps/api fills the runner slot it waits, then FAILS
 * (visible in pg-boss); a registered runner gets the job's payload as sent; a
 * runner failure fails the job (pg-boss retries it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDevLoopObservation,
  registerDevLoopRunner,
  resetDevLoopRunnerForTests,
} from "../dev-loop-worker.js";

const payload = {
  eventType: "dev.pr_merged",
  data: { repo: "a/b", number: 1, url: "https://github.com/a/b/pull/1" },
  userId: "user-1",
  producerAgentUserId: "agent-1",
  eventId: "ev-1",
  grant: null,
};
const job = (data: unknown) => ({ id: "j1", name: "q", data }) as never;

afterEach(() => resetDevLoopRunnerForTests());

describe("handleDevLoopObservation", () => {
  it("waits for the runner and then runs the job", async () => {
    const runner = vi.fn(async () => ({ status: "swept" }));
    const pending = handleDevLoopObservation(job(payload), { waitMs: 5_000 });
    registerDevLoopRunner(runner);
    await pending;
    expect(runner).toHaveBeenCalledWith(payload);
  });

  it("no runner within the wait: the job fails, it never reads as done", async () => {
    await expect(
      handleDevLoopObservation(job(payload), { waitMs: 10 })
    ).rejects.toThrow(/did not run/);
  });

  it("a runner failure FAILS the job, so pg-boss retries it", async () => {
    registerDevLoopRunner(async () => {
      throw new Error("db blip");
    });
    await expect(
      handleDevLoopObservation(job(payload), { waitMs: 0 })
    ).rejects.toThrow(/db blip/);
  });

  it("drops a malformed payload without calling the runner", async () => {
    const runner = vi.fn(async () => null);
    registerDevLoopRunner(runner);
    await handleDevLoopObservation(job({ eventType: "dev.pr_merged" }), {
      waitMs: 0,
    });
    expect(runner).not.toHaveBeenCalled();
  });
});
