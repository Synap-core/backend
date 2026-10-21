/**
 * The duplicate door's pending leg and its answer shape, on a stub db (the
 * record leg is driven for real through `entities.create` in
 * `routers/entities/create.duplicate-door.pglite.test.ts`).
 *
 * Rows that rule out a wrong rule:
 *  - an in-flight twin found by a strong atom is a PROPOSAL candidate, never an
 *    entity id to link (ported from the deleted `findPendingSignalMatches`);
 *  - same name, other kind is NOT a twin (same kind only, B2d);
 *  - an entity/create proposal is read too (the old scan saw graphs only);
 *  - a pending op that LINKS an existing record proposes nothing;
 *  - a failed read is `unchecked`, never `clear`.
 */
import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  findDuplicateCandidates,
  findPendingIdentityMatches,
  loadOwnPendingCreates,
  toDuplicateCheck,
} from "./find-duplicate-candidates.js";

/** Minimal chainable stub matching `db.select().from().where().orderBy().limit()`. */
function stubDb(rows: unknown[] | Error) {
  const limit =
    rows instanceof Error
      ? vi.fn().mockRejectedValue(rows)
      : vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, select };
}

const graphRow = {
  id: "prop-graph",
  targetType: "entity",
  proposalType: "capture.graph",
  data: {
    operations: [
      {
        op: "create_entity",
        ref: "e0",
        profileSlug: "person",
        title: "Ada Lovelace",
        properties: { email: "ada@example.com" },
      },
      {
        op: "create_entity",
        ref: "e1",
        profileSlug: "person",
        title: "Linked Larry",
        existingEntityId: "ent-999",
        properties: { email: "larry@example.com" },
      },
    ],
  },
};
const singleRow = {
  id: "prop-single",
  targetType: "entity",
  proposalType: "create",
  data: {
    requestId: "r",
    targetType: "entity",
    changeType: "create",
    data: { id: "minted", profileSlug: "decision", title: "Ship on Monday" },
  },
};

describe("loadOwnPendingCreates", () => {
  it("reads graph ops AND single entity creates; a linking op proposes nothing", async () => {
    const creates = await loadOwnPendingCreates(
      stubDb([graphRow, singleRow]).db,
      "user-1"
    );
    expect(creates.map((c) => [c.proposalId, c.kind, c.nameKey])).toEqual([
      ["prop-graph", "person", "ada lovelace"],
      ["prop-single", "decision", "ship on monday"],
    ]);
  });
});

describe("findPendingIdentityMatches (the resolve-identity lookup)", () => {
  it("returns [] and NEVER queries when no strong signals are supplied", async () => {
    const stub = stubDb([]);
    expect(await findPendingIdentityMatches(stub.db, "user-1", [])).toEqual([]);
    expect(stub.select).not.toHaveBeenCalled();
  });

  it("an in-flight strong-atom twin is a proposalId, never an entityId", async () => {
    const out = await findPendingIdentityMatches(
      stubDb([graphRow]).db,
      "user-1",
      [{ type: "email", value: "ADA@example.com" }]
    );
    expect(out).toEqual([
      {
        proposalId: "prop-graph",
        proposalType: "capture.graph",
        entityRef: "e0",
        entityTitle: "Ada Lovelace",
        profileSlug: "person",
        matchedSignals: [{ type: "email", value: "ada@example.com" }],
      },
    ]);
  });

  it("a linking op never matches, even on its atom", async () => {
    const out = await findPendingIdentityMatches(
      stubDb([graphRow]).db,
      "user-1",
      [{ type: "email", value: "larry@example.com" }]
    );
    expect(out).toEqual([]);
  });
});

describe("findDuplicateCandidates — pending leg (preloaded queue)", () => {
  const recordScope = sql`true`;
  async function entity(
    title: string,
    profileSlug: string,
    signals: Array<{ type: string; value: string }> = []
  ) {
    const pending = await loadOwnPendingCreates(
      stubDb([graphRow, singleRow]).db,
      "user-1"
    );
    // The record leg has no db here: it FAILS, which must read `unchecked`
    // only when nothing else answered.
    return findDuplicateCandidates({} as never, {
      subject: "entity",
      userId: "user-1",
      profileSlug,
      title,
      signals: signals as never,
      recordScope,
      pending,
    });
  }

  it("same kind + same name in the queue is a possible twin (the proposal)", async () => {
    const { check } = await entity("  ship on   MONDAY ", "decision");
    expect(check.status).toBe("possible");
    expect(check.candidates).toEqual([
      expect.objectContaining({
        ref: "proposal",
        id: "prop-single",
        kind: "decision",
        why: "same_name",
      }),
    ]);
  });

  it("same name, OTHER kind is not a twin — and the failed record leg says unchecked", async () => {
    const { check } = await entity("Ship on Monday", "task");
    expect(check.candidates).toEqual([]);
    expect(check.status).toBe("unchecked");
  });

  it("a strong atom on a pending create is a twin even under another name", async () => {
    const { check } = await entity("A. Lovelace", "person", [
      { type: "email", value: "ada@example.com" },
    ]);
    expect(check.candidates).toEqual([
      expect.objectContaining({
        ref: "proposal",
        id: "prop-graph",
        why: "same_identity",
      }),
    ]);
  });

  it("a failed pending read is unchecked, never clear", async () => {
    const { check } = await findDuplicateCandidates(
      stubDb(new Error("boom")).db,
      {
        subject: "playbook",
        userId: "user-1",
        name: "Weekly review",
        workspaceId: null,
      }
    );
    expect(check).toEqual({
      status: "unchecked",
      subject: "playbook",
      candidates: [],
    });
  });
});

describe("toDuplicateCheck", () => {
  it("clear only when the door looked and found nothing", () => {
    expect(toDuplicateCheck("entity", [], false).status).toBe("clear");
    expect(toDuplicateCheck("entity", [], true).status).toBe("unchecked");
  });

  it("caps candidates and says so", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      ref: "record" as const,
      id: `e${i}`,
      kind: "note",
      title: "Same",
      why: "same_name" as const,
    }));
    const check = toDuplicateCheck("entity", many, false);
    expect(check.candidates).toHaveLength(5);
    expect(check.truncated).toBe(true);
  });
});
