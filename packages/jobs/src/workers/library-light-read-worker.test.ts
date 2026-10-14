/**
 * The light-read queue is a SLOT: jobs owns the queue, the api fills the
 * handler at boot. The job's output is the handler's result (pg-boss stores
 * it), and a sweep that fires before the api filled its slot is a no-op.
 */
import { describe, it, expect } from "vitest";
import type PgBoss from "pg-boss";
import {
  handleLibraryLightRead,
  handleLibraryLightReadSweep,
  registerLibraryLightReadHandler,
  registerLibraryLightReadSweepHandler,
  type LibraryLightReadPayload,
} from "./library-light-read-worker.js";

const job = (data: LibraryLightReadPayload) =>
  ({
    id: "j1",
    name: "library-light-read",
    data,
  }) as PgBoss.Job<LibraryLightReadPayload>;

describe("library-light-read worker", () => {
  it("an unfilled read slot throws (the job retries once the api is up)", async () => {
    await expect(
      handleLibraryLightRead(job({ userId: "u", itemId: "i" }))
    ).rejects.toThrow(/not registered/);
  });

  it("an unfilled sweep slot is a no-op, not a failure", async () => {
    await expect(handleLibraryLightReadSweep()).resolves.toEqual({
      enqueued: 0,
    });
  });

  it("returns what the handler did (the job output)", async () => {
    registerLibraryLightReadHandler(async (p) => ({
      itemId: p.itemId,
      status: "read",
      chars: 12,
      actions: 1,
      usedAi: false,
    }));
    registerLibraryLightReadSweepHandler(async () => ({ enqueued: 3 }));
    await expect(
      handleLibraryLightRead(job({ userId: "u", itemId: "i" }))
    ).resolves.toEqual({
      itemId: "i",
      status: "read",
      chars: 12,
      actions: 1,
      usedAi: false,
    });
    await expect(handleLibraryLightReadSweep()).resolves.toEqual({
      enqueued: 3,
    });
  });
});
