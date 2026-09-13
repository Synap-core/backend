/**
 * `connectors.syncNow` — the client contract, through the real procedure.
 *
 * `{ enqueued: count > 0, count: <queued>, debounced: <n> }`. A debounced
 * connection already has a sync queued or running, which is a normal state: it
 * is reported, never thrown — also when EVERY target was debounced. Only a real
 * failure throws (not the owner's connection, the queue down). Clients render a
 * throw as "Sync failed", so a thrown debounce would report a healthy sync as
 * broken.
 *
 * The service door is replaced by a recorder; its own behaviour (owner checks,
 * counting `queued` vs `debounced`) is pinned by
 * `capability-nango-sync.sync-now.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  outcome: null as unknown,
  throwError: null as Error | null,
}));

vi.mock(
  "../services/capabilities/capability-nango-sync.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    enqueueManualConnectionSync: vi.fn(async () => {
      if (h.throwError) throw h.throwError;
      return h.outcome;
    }),
  })
);

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});

vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { connectorsRouter } from "./connectors-trpc.js";
import type { Context } from "../types/context.js";

const caller = () =>
  connectorsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
  } as unknown as Context);

beforeEach(() => {
  h.outcome = null;
  h.throwError = null;
});

describe("connectors.syncNow", () => {
  it("every connection debounced → an ok result, NOT a throw", async () => {
    h.outcome = { ok: true, queued: 0, debounced: 2 };
    await expect(caller().syncNow({ provider: "google" })).resolves.toEqual({
      enqueued: false,
      count: 0,
      debounced: 2,
    });
  });

  it("some queued, some debounced → enqueued with both counts", async () => {
    h.outcome = { ok: true, queued: 1, debounced: 1 };
    await expect(caller().syncNow({ provider: "google" })).resolves.toEqual({
      enqueued: true,
      count: 1,
      debounced: 1,
    });
  });

  it("not the caller's connection → NOT_FOUND", async () => {
    h.outcome = {
      ok: false,
      reason: "not_found",
      error: "Connection not found",
    };
    await expect(
      caller().syncNow({ connectionId: "row-theirs" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a real failure (queue down) throws", async () => {
    h.throwError = new Error("pg-boss unavailable");
    await expect(caller().syncNow({ provider: "google" })).rejects.toThrow(
      /pg-boss unavailable/
    );
  });
});
