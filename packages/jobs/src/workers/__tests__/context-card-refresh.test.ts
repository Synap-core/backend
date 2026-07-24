import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the context-card refresh cron.
 *  - dedupeRefreshTargets: pure — collapses per (entityId, externalId), drops
 *    rows missing either.
 *  - handleContextCardRefresh: mocks the DB + enqueue door and asserts the TEAM
 *    firewall (branchPurpose='team') is in the WHERE and one refresh_context_card
 *    egress is enqueued per deduped team thread (payload = { channelId }).
 */

const { loggerMock, selectMock, enqueueMock, whereCapture } = vi.hoisted(
  () => ({
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    selectMock: vi.fn(),
    enqueueMock: vi.fn(),
    whereCapture: { arg: undefined as unknown },
  })
);

function queryResult(rows: unknown[]) {
  const q: any = {
    from: () => q,
    where: (arg: unknown) => {
      whereCapture.arg = arg;
      return q;
    },
    then: (
      resolve: (v: unknown[]) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(rows).then(resolve, reject),
  };
  return q;
}

vi.mock("@synap/database", () => ({
  db: { select: selectMock },
  enqueueChannelEgress: enqueueMock,
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
}));

vi.mock("@synap/database/schema", () => ({
  channels: {
    contextObjectId: "context_object_id",
    externalId: "external_id",
    workspaceId: "workspace_id",
    externalSource: "external_source",
    branchPurpose: "branch_purpose",
  },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => loggerMock,
}));

import {
  dedupeRefreshTargets,
  handleContextCardRefresh,
  CONTEXT_CARD_REFRESH_QUEUE,
  CONTEXT_CARD_REFRESH_CRON,
  type TeamThreadRow,
} from "../context-card-refresh.js";

beforeEach(() => {
  selectMock.mockReset();
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue({ id: "egress-1" });
  whereCapture.arg = undefined;
});

describe("dedupeRefreshTargets", () => {
  it("collapses duplicates per (entityId, externalId)", () => {
    const rows: TeamThreadRow[] = [
      { entityId: "e1", externalId: "d1", workspaceId: "w1" },
      { entityId: "e1", externalId: "d1", workspaceId: "w1" },
      { entityId: "e1", externalId: "d2", workspaceId: "w1" },
    ];
    const out = dedupeRefreshTargets(rows);
    expect(out).toEqual([
      { entityId: "e1", externalId: "d1", workspaceId: "w1" },
      { entityId: "e1", externalId: "d2", workspaceId: "w1" },
    ]);
  });

  it("drops rows missing an entity binding or an external id", () => {
    const rows: TeamThreadRow[] = [
      { entityId: null, externalId: "d1", workspaceId: null },
      { entityId: "e1", externalId: null, workspaceId: null },
      { entityId: "e2", externalId: "d3", workspaceId: null },
    ];
    expect(dedupeRefreshTargets(rows)).toEqual([
      { entityId: "e2", externalId: "d3", workspaceId: null },
    ]);
  });
});

describe("handleContextCardRefresh", () => {
  it("enqueues refresh_context_card ONLY for team threads, deduped", async () => {
    selectMock.mockReturnValueOnce(
      queryResult([
        { entityId: "e1", externalId: "d1", workspaceId: "w1" },
        { entityId: "e1", externalId: "d1", workspaceId: "w1" }, // dup
        { entityId: "e2", externalId: "d2", workspaceId: null },
      ])
    );

    await handleContextCardRefresh();

    // TEAM firewall: the WHERE must pin branchPurpose='team' (+ discord source
    // + a bound entity). Assert it is encoded in the captured predicate.
    const conds = (whereCapture.arg as { op: string; args: unknown[] }).args;
    expect(conds).toContainEqual({
      op: "eq",
      col: "branch_purpose",
      val: "team",
    });
    expect(conds).toContainEqual({
      op: "eq",
      col: "external_source",
      val: "discord",
    });
    expect(conds).toContainEqual({ op: "isNotNull", col: "context_object_id" });

    // One egress per deduped thread, exact payload contract.
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(enqueueMock).toHaveBeenCalledWith({
      externalSource: "discord",
      externalId: "d1",
      kind: "refresh_context_card",
      payload: { channelId: "d1" },
      workspaceId: "w1",
    });
    expect(enqueueMock).toHaveBeenCalledWith({
      externalSource: "discord",
      externalId: "d2",
      kind: "refresh_context_card",
      payload: { channelId: "d2" },
      workspaceId: null,
    });
  });

  it("exposes stable queue + cron constants", () => {
    expect(CONTEXT_CARD_REFRESH_QUEUE).toBe("context-card-refresh");
    expect(CONTEXT_CARD_REFRESH_CRON).toBe("10 6 * * *");
  });
});
