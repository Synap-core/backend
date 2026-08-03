/**
 * Fireflies worker — the queue boundary between the inbound webhook and the
 * api-side ingest runner (fetch-then-land). No DB/IS: we assert the handler's
 * wiring + guards around the IoC-injected runner.
 *
 *   - drops a malformed job payload WITHOUT calling the runner
 *   - forwards a valid payload to the registered runner verbatim (fetch→ingest)
 *   - RE-THROWS on runner failure so pg-boss retries the ingest job
 *   - the backfill cron handler SWALLOWS runner errors (no retry-storm)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const {
  handleFirefliesIngest,
  handleFirefliesBackfillCron,
  registerFirefliesIngestRunner,
  registerFirefliesBackfillRunner,
  FIREFLIES_INGEST_QUEUE,
  FIREFLIES_BACKFILL_CRON_QUEUE,
} = await import("../fireflies-worker.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const job = (data: unknown): any => ({ id: "j1", name: "q", data });

describe("fireflies-worker queue names", () => {
  it("exposes stable queue names", () => {
    expect(FIREFLIES_INGEST_QUEUE).toBe("fireflies-ingest");
    expect(FIREFLIES_BACKFILL_CRON_QUEUE).toBe("fireflies-backfill-cron");
  });
});

describe("handleFirefliesIngest", () => {
  let runner: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    runner = vi.fn().mockResolvedValue({ recorded: true });
    registerFirefliesIngestRunner(
      runner as unknown as Parameters<typeof registerFirefliesIngestRunner>[0]
    );
  });

  it("forwards a valid payload to the runner (fetch→ingest wiring)", async () => {
    const data = {
      meetingId: "M1",
      clientReferenceId: "c1",
      toolId: "tool-ff",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    };
    await handleFirefliesIngest(job(data));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(data);
  });

  it("drops a malformed payload without calling the runner", async () => {
    await handleFirefliesIngest(job({ meetingId: "M1" })); // no toolId/ownerUserId
    await handleFirefliesIngest(job({ toolId: "t", ownerUserId: "o" })); // no meetingId
    expect(runner).not.toHaveBeenCalled();
  });

  it("re-throws on runner failure so pg-boss retries", async () => {
    runner.mockRejectedValueOnce(new Error("graphql timeout"));
    await expect(
      handleFirefliesIngest(
        job({ meetingId: "M1", toolId: "t", ownerUserId: "o" })
      )
    ).rejects.toThrow("graphql timeout");
  });
});

describe("handleFirefliesBackfillCron", () => {
  it("swallows runner errors (a cron must not retry-storm)", async () => {
    registerFirefliesBackfillRunner(
      vi.fn().mockRejectedValue(new Error("boom")) as unknown as Parameters<
        typeof registerFirefliesBackfillRunner
      >[0]
    );
    await expect(handleFirefliesBackfillCron(job({}))).resolves.toBeUndefined();
  });
});
