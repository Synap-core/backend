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

  /**
   * REVOKE-then-INSERT is two statements, so two concurrent identical binds can
   * both revoke the incumbent and then race on the partial unique index. The
   * loser's 23505 is not a conflict the USER caused — by the time it retries,
   * the winner's row is simply the new incumbent, which the retry supersedes.
   */
  describe("the revoke-then-insert race", () => {
    /**
     * A recording db whose first N inserts raise `err`. Built standalone rather
     * than by patching `makeDb`'s result: the fake hands the TRANSACTION its
     * own `chain` object, so overriding `db.insert` after the fact is never
     * seen by the code under test.
     */
    function makeRacingDb(err: unknown, failures = 1) {
      const rec: Recorded = { updates: [], inserts: [], order: [] };
      let remaining = failures;
      const chain = {
        update: () => ({
          set: (patch: unknown) => ({
            where: (predicate: unknown) => {
              rec.updates.push({ patch, predicate });
              rec.order.push("update");
              return { returning: async () => [], then: undefined };
            },
          }),
        }),
        insert: () => ({
          values: (values: Record<string, unknown>) => ({
            returning: async () => {
              if (remaining > 0) {
                remaining--;
                throw err;
              }
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
      return { db: db as never, rec };
    }

    const pgUnique = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });

    it("retries ONCE and succeeds when the loser hits 23505", async () => {
      const { db, rec } = makeRacingDb(pgUnique);
      const row = await setRendererBinding(db, {
        ...workspaceKey,
        ref,
        actorUserId: "u-1",
      });
      expect(row).toMatchObject({ scopeKind: "workspace" });
      // The retry re-runs the WHOLE door, so the winner's row is superseded
      // first — two revokes, and only the surviving insert is recorded (the
      // losing one threw before it could record).
      expect(rec.order).toEqual(["update", "update", "insert"]);
      expect(rec.updates).toHaveLength(2);
      expect(rec.inserts).toHaveLength(1);
    });

    it("sees 23505 through a wrapping driver error", async () => {
      const wrapped = Object.assign(new Error("insert failed"), {
        cause: { code: "23505" },
      });
      const { db } = makeRacingDb(wrapped);
      await expect(
        setRendererBinding(db, { ...workspaceKey, ref, actorUserId: "u-1" })
      ).resolves.toMatchObject({ scopeKind: "workspace" });
    });

    it("gives up after ONE retry — a second 23505 is not this race", async () => {
      const { db } = makeRacingDb(pgUnique, 2);
      await expect(
        setRendererBinding(db, { ...workspaceKey, ref, actorUserId: "u-1" })
      ).rejects.toThrow(/duplicate key/);
    });

    it("never retries an error that is not a unique violation", async () => {
      const other = Object.assign(new Error("connection reset"), {
        code: "08006",
      });
      const { db, rec } = makeRacingDb(other);
      await expect(
        setRendererBinding(db, { ...workspaceKey, ref, actorUserId: "u-1" })
      ).rejects.toThrow(/connection reset/);
      // One attempt only: retrying an unrelated failure would double-revoke.
      expect(rec.updates).toHaveLength(1);
    });
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
