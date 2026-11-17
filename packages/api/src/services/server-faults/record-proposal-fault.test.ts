/**
 * A failed approval's exact cause is kept for the pod's owner (plan 8032a127
 * D5, finding 7ca4953f): `recordProposalFault` writes it to `server_faults`
 * (door `proposal`), redacted, and answers the errorId the proposal stores. It
 * answers no id when nothing was written, so a row never points at a fault
 * that does not exist.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { rows, insert } = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    insert: vi.fn(async (_db: unknown, row: Record<string, unknown>) => {
      rows.push(row);
    }),
  };
});
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertServerFault: insert,
  deleteExpiredServerFaults: async () => 0,
}));

import {
  FAULT_WRITES_PER_MINUTE,
  recordProposalFault,
  recordServerFault,
  resetServerFaultBudget,
} from "./record.js";

const TOKEN = "sk-live-AbCdEf0123456789XYZ";
const PROPOSAL = "5d3c9a1e-0000-4000-8000-0000000000a1";

beforeEach(() => {
  rows.length = 0;
  insert.mockClear();
  resetServerFaultBudget();
});

describe("recordProposalFault", () => {
  it("keeps the raw cause and its stack, redacted, under the id it returns", async () => {
    const cause = new Error(`provider said 401: {"api_key":"${TOKEN}"}`);
    const err = new Error("approve failed", { cause });

    const errorId = await recordProposalFault({
      proposalId: PROPOSAL,
      err,
      meta: { errorClass: "validation" },
      userId: "owner-1",
      agentUserId: "agent-1",
    });

    expect(errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      errorId,
      door: "proposal",
      path: `/proposal/${PROPOSAL}`,
      // `validation` answers BAD_REQUEST: the column keeps an HTTP status.
      status: 400,
      userId: "owner-1",
      agentUserId: "agent-1",
      errorName: "Error",
      message: "approve failed",
    });
    expect(row.stack).toContain("record-proposal-fault.test");
    const causes = row.causes as Array<{ message: string }>;
    expect(causes[0]!.message).toContain("provider said 401");
    // The credential a provider body echoed never reaches the row.
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it("an unclassified failure is a 500", async () => {
    await recordProposalFault({
      proposalId: PROPOSAL,
      err: new Error("boom"),
      meta: {},
    });
    expect(rows[0]!.status).toBe(500);
  });

  it("answers no id when the write failed", async () => {
    insert.mockRejectedValueOnce(new Error("db down"));
    expect(
      await recordProposalFault({
        proposalId: PROPOSAL,
        err: new Error("boom"),
        meta: {},
      })
    ).toBeUndefined();
  });

  it("answers no id once the minute's budget is spent", async () => {
    for (let i = 0; i < FAULT_WRITES_PER_MINUTE; i++) {
      await recordServerFault({
        errorId: `e${i}`,
        door: "rest",
        status: 500,
        fault: { name: "Error", message: "x", stack: null, causes: [] },
      });
    }
    expect(
      await recordProposalFault({
        proposalId: PROPOSAL,
        err: new Error("boom"),
        meta: {},
      })
    ).toBeUndefined();
  });
});
