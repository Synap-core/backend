/**
 * The expiry scanner is the DOMINANT source-blob leak path.
 *
 * `reject` and `batchReject` discarded a staged blob; the scanners did not —
 * and they are the doors that reach a terminal state with NO human action at
 * all. Every un-triaged file-carrying proposal therefore orphaned its bytes AND
 * its `documents` row, permanently, because a decided proposal is never deleted
 * and nothing else ever looks at `data.sourceFile` again.
 *
 * This is the BEHAVIOURAL half (the structural, all-doors half is
 * `__tripwires__/source-blob-ownership-and-terminal-discard.test.ts`): it runs
 * the real scanner over a fake table and asserts the discard door is reached —
 * for the row that actually expired, and NOT for one the UPDATE did not move.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const discardProposalSourceBlobMock = vi.fn();
vi.mock("../../utils/store-entity-source-blob.js", () => ({
  discardProposalSourceBlob: (...a: unknown[]) =>
    discardProposalSourceBlobMock(...a),
}));

vi.mock("../../notifications/mark-proposal-notifications-actioned.js", () => ({
  markProposalNotificationsActioned: vi.fn(),
}));

/** Rows the fake `select` returns, and the ids the fake `update` claims to move. */
let pendingRows: Array<Record<string, unknown>> = [];
let movedIds: string[] = [];

// TOTAL mock — every symbol the module under test imports from @synap/database
// must be listed, or it is `undefined` at runtime with no type error.
vi.mock("@synap/database", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(pendingRows) }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(movedIds.map((id) => ({ id }))),
        }),
      }),
    }),
  },
  proposals: {
    id: "id",
    proposalType: "proposal_type",
    targetType: "target_type",
    createdAt: "created_at",
    data: "data",
    status: "status",
    sessionId: "session_id",
  },
  ProposalStatus: { PENDING: "pending", EXPIRED: "expired" },
  eq: (...a: unknown[]) => ({ _eq: a }),
  and: (...a: unknown[]) => ({ _and: a }),
  inArray: (...a: unknown[]) => ({ _in: a }),
  lt: (...a: unknown[]) => ({ _lt: a }),
}));

import {
  expireLapsedProposals,
  expireSessionEphemerals,
} from "./expire-lapsed-proposals.js";

const SOURCE_FILE = {
  documentId: "doc-1",
  storageKey: "users/u1/entity/cap-1.pdf",
  storageUrl: "https://storage.example/cap-1.pdf",
  size: 10,
  mimeType: "application/pdf",
};

const NOW = new Date("2026-09-02T12:00:00Z");
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);

describe("expiry discards the staged source blob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingRows = [];
    movedIds = [];
  });

  it("expireLapsedProposals discards the blob of a row it expired", async () => {
    pendingRows = [
      {
        id: "p-file",
        proposalType: "capability.run",
        targetType: "capability",
        createdAt: daysAgo(12),
        data: { sourceFile: SOURCE_FILE },
      },
    ];
    movedIds = ["p-file"];

    const res = await expireLapsedProposals(NOW);
    expect(res.expired).toBe(1);
    expect(discardProposalSourceBlobMock).toHaveBeenCalledTimes(1);
    expect(discardProposalSourceBlobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalData: { sourceFile: SOURCE_FILE },
        // A scanner has no acting human — the discard door then authorizes
        // against the loaded `documents` row itself.
        userId: null,
      })
    );
  });

  it("does NOT discard for a row the guarded UPDATE did not move", async () => {
    // A human approved it between the read and the write: the re-asserted
    // `status = PENDING` predicate matched nothing, so the blob is still theirs.
    pendingRows = [
      {
        id: "p-file",
        proposalType: "capability.run",
        targetType: "capability",
        createdAt: daysAgo(12),
        data: { sourceFile: SOURCE_FILE },
      },
    ];
    movedIds = [];

    const res = await expireLapsedProposals(NOW);
    expect(res.expired).toBe(0);
    expect(discardProposalSourceBlobMock).not.toHaveBeenCalled();
  });

  it("expireSessionEphemerals discards too (the session-close trigger)", async () => {
    pendingRows = [
      {
        id: "p-file",
        proposalType: "capability.run",
        targetType: "capability",
        data: { sourceFile: SOURCE_FILE },
      },
    ];
    movedIds = ["p-file"];

    const moved = await expireSessionEphemerals("s-1", NOW);
    expect(moved).toBe(1);
    expect(discardProposalSourceBlobMock).toHaveBeenCalledWith(
      expect.objectContaining({ proposalData: { sourceFile: SOURCE_FILE } })
    );
  });

  it("a blob-less proposal reaches the door and no-ops there (no drift by omission)", async () => {
    // The door is called UNCONDITIONALLY and no-ops on data with no
    // `sourceFile` — which is what keeps the four terminal doors from drifting.
    pendingRows = [
      {
        id: "p-plain",
        proposalType: "capability.run",
        targetType: "capability",
        createdAt: daysAgo(12),
        data: { some: "payload" },
      },
    ];
    movedIds = ["p-plain"];

    await expireLapsedProposals(NOW);
    expect(discardProposalSourceBlobMock).toHaveBeenCalledWith(
      expect.objectContaining({ proposalData: { some: "payload" } })
    );
  });
});
