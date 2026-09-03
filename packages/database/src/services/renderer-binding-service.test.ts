/**
 * The `renderer_bindings` write door — shape floor and revoke-then-insert.
 *
 * No PostgreSQL: the door's contract is WHICH statements it issues in WHICH
 * order, so a recording fake proves it without a connection. (A DB-backed test
 * would also prove the partial unique index, but that index is K1's and is
 * already asserted by schema coherence.)
 */

import { describe, expect, it } from "vitest";

import {
  revokeRendererBinding,
  setRendererBinding,
} from "./renderer-binding-service.js";

interface Recorded {
  updates: unknown[];
  inserts: Record<string, unknown>[];
  order: string[];
}

function makeDb(existingActive: { id: string }[] = []) {
  const rec: Recorded = { updates: [], inserts: [], order: [] };
  const chain = {
    update: () => ({
      set: (patch: unknown) => ({
        where: (predicate: unknown) => {
          rec.updates.push({ patch, predicate });
          rec.order.push("update");
          return {
            returning: async () => existingActive,
            // `await`-ing this object without `.returning()` is a no-op, which
            // is exactly what the set path does.
            then: undefined,
          };
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          rec.inserts.push(values);
          rec.order.push("insert");
          return [{ id: "row-new", ...values }];
        },
      }),
    }),
  };
  const db = {
    ...chain,
    transaction: async (cb: (tx: typeof chain) => Promise<unknown>) =>
      cb(chain),
  };
  // The service is typed against the real Drizzle db; the fake implements only
  // the two builders it touches.
  return { db: db as never, rec };
}

const ref = { kind: "cell" as const, cellKey: "contact-card", props: {} };

const workspaceKey = {
  scopeKind: "workspace" as const,
  workspaceId: "ws-1",
  subjectKind: "person",
  contentKind: "entity-detail" as const,
};

describe("setRendererBinding", () => {
  it("revokes the incumbent BEFORE inserting the replacement", async () => {
    const { db, rec } = makeDb();
    await setRendererBinding(db, {
      ...workspaceKey,
      ref,
      actorUserId: "u-1",
    });
    expect(rec.order).toEqual(["update", "insert"]);
    expect(rec.updates).toHaveLength(1);
    // Supersede, never overwrite — the incumbent is tombstoned, not mutated.
    expect(
      (rec.updates[0] as { patch: { revokedAt: Date } }).patch.revokedAt
    ).toBeInstanceOf(Date);
  });

  it("nulls the owner column the scope does not own", async () => {
    const { db, rec } = makeDb();
    await setRendererBinding(db, {
      ...workspaceKey,
      ref,
      actorUserId: "u-1",
    });
    expect(rec.inserts[0]).toMatchObject({
      scopeKind: "workspace",
      workspaceId: "ws-1",
      userId: null,
      subjectId: null,
      createdBy: "u-1",
    });
  });

  it("records proposal lineage when an approval minted the row", async () => {
    const { db, rec } = makeDb();
    await setRendererBinding(db, {
      ...workspaceKey,
      ref,
      actorUserId: "u-1",
      sourceProposalId: "prop-9",
    });
    expect(rec.inserts[0].sourceProposalId).toBe("prop-9");
  });

  it("carries subjectId for a per-object binding", async () => {
    const { db, rec } = makeDb();
    await setRendererBinding(db, {
      ...workspaceKey,
      subjectId: "entity-7",
      ref,
      actorUserId: "u-1",
    });
    expect(rec.inserts[0].subjectId).toBe("entity-7");
  });

  it.each([
    ["user scope without a userId", { scopeKind: "user" as const }],
    [
      "workspace scope without a workspaceId",
      { scopeKind: "workspace" as const },
    ],
  ])("refuses %s", async (_label, override) => {
    const { db } = makeDb();
    await expect(
      setRendererBinding(db, {
        subjectKind: "person",
        contentKind: "entity-detail",
        ref,
        actorUserId: "u-1",
        ...override,
      })
    ).rejects.toThrow(/requires a (userId|workspaceId)/);
  });

  it("refuses an owner column set on a scope that does not own it", async () => {
    const { db } = makeDb();
    await expect(
      setRendererBinding(db, {
        scopeKind: "pod",
        userId: "u-2",
        subjectKind: "person",
        contentKind: "entity-detail",
        ref,
        actorUserId: "u-1",
      })
    ).rejects.toThrow(/must not carry a userId/);
  });
});

describe("revokeRendererBinding", () => {
  it("tombstones the active row and reports how many it touched", async () => {
    const { db, rec } = makeDb([{ id: "row-old" }]);
    const result = await revokeRendererBinding(db, {
      ...workspaceKey,
      actorUserId: "u-1",
    });
    expect(result).toEqual({ revoked: 1 });
    expect(rec.order).toEqual(["update"]);
    expect(rec.inserts).toHaveLength(0);
  });

  it("is a no-op when nothing is bound", async () => {
    const { db } = makeDb([]);
    await expect(
      revokeRendererBinding(db, { ...workspaceKey, actorUserId: "u-1" })
    ).resolves.toEqual({ revoked: 0 });
  });
});
