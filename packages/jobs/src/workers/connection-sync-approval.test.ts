/**
 * The worker delegates to the one helper and lets a failure THROW (pg-boss
 * retries) — a rule that silently failed to mint would leave every later sync
 * proposing with nothing saying why.
 *
 * The helper stub is a plain swappable function, NOT a `vi.fn` with an async
 * implementation: on this package's vitest (1.6) the spy chains `.then` onto the
 * returned promise without a catch, so a rejecting implementation surfaces as an
 * unhandled rejection even when the caller catches it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as unknown[],
  impl: (async () => ({ applied: true })) as (
    input: unknown
  ) => Promise<unknown>,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/database", () => ({
  applyConnectionSyncApprovalForProposal: (input: unknown) => {
    h.calls.push(input);
    return h.impl(input);
  },
}));

const { handleConnectionSyncApproval } =
  await import("./connection-sync-approval.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const job = (data: unknown) => ({ data }) as any;

beforeEach(() => {
  h.calls.length = 0;
  h.impl = async () => ({ applied: true, ruleId: "r1", created: true });
});

describe("handleConnectionSyncApproval", () => {
  it("hands the proposal + approver to the helper", async () => {
    await handleConnectionSyncApproval(job({ proposalId: "p1", userId: "u1" }));
    expect(h.calls).toEqual([{ proposalId: "p1", userId: "u1" }]);
  });

  it("a helper failure propagates (so pg-boss retries)", async () => {
    h.impl = () => Promise.reject(new Error("db down"));
    let caught: unknown;
    try {
      await handleConnectionSyncApproval(
        job({ proposalId: "p1", userId: "u1" })
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as Error | undefined)?.message).toBe("db down");
  });

  it("a malformed job does not call the helper", async () => {
    await handleConnectionSyncApproval(job({ proposalId: "p1" }));
    expect(h.calls).toHaveLength(0);
  });
});
