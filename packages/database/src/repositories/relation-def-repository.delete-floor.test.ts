/**
 * ACCESS-FLOOR guard for `RelationDefRepository.delete`.
 *
 * `relation_defs` rows with `workspace_id IS NULL` are the pod-wide base layer
 * that EVERY workspace resolves through. They are deliberately VISIBLE under a
 * workspace lens (access registry: `includeGlobalsInLens: true`), and the tRPC
 * router gates deletion on the caller's role in their OWN workspace — so
 * without a floor here, a workspace admin could delete a def the whole pod
 * depends on. Before this floor `delete` was `where(eq(relationDefs.id, id))`
 * with NO workspace predicate at all.
 *
 * The floor is asserted in JS rather than folded into the DELETE's WHERE
 * precisely so it is provable without a live Postgres — a guard living only
 * inside a SQL predicate is invisible to a mocked query and therefore untested.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RelationDefRepository } from "./relation-def-repository.js";

type Row = { id: string; workspaceId: string | null } | undefined;

let storedRow: Row;
let deleteCalls = 0;

function makeRepo() {
  const db = {
    query: {
      relationDefs: { findFirst: async () => storedRow },
    },
    delete: () => ({
      where: () => ({
        returning: async () => {
          deleteCalls += 1;
          return storedRow ? [{ id: storedRow.id }] : [];
        },
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return new RelationDefRepository(db);
}

describe("RelationDefRepository.delete — workspace floor", () => {
  beforeEach(() => {
    deleteCalls = 0;
  });

  it("REFUSES to delete a pod-wide def for a workspace-scoped caller", async () => {
    storedRow = { id: "reldef-podwide", workspaceId: null };

    await expect(makeRepo().delete("reldef-podwide", "ws-1")).rejects.toThrow(
      /not found/i
    );
    // The DELETE must never be issued — a floor that throws AFTER the row is
    // gone is not a floor.
    expect(deleteCalls).toBe(0);
  });

  it("REFUSES to delete another workspace's def", async () => {
    storedRow = { id: "reldef-other", workspaceId: "ws-2" };

    await expect(makeRepo().delete("reldef-other", "ws-1")).rejects.toThrow(
      /not found/i
    );
    expect(deleteCalls).toBe(0);
  });

  it("still deletes the caller's OWN workspace def", async () => {
    // The narrowing must not take away anything a caller could legitimately
    // delete before: their own workspace's rows.
    storedRow = { id: "reldef-mine", workspaceId: "ws-1" };

    await expect(
      makeRepo().delete("reldef-mine", "ws-1")
    ).resolves.toBeUndefined();
    expect(deleteCalls).toBe(1);
  });

  it("keeps the unscoped path for a pod-level caller (no workspace passed)", async () => {
    // Omitting the workspace preserves the pre-existing behaviour exactly, so
    // this change is a narrowing of the workspace-scoped router only — it does
    // not widen anything for pod-level callers.
    storedRow = { id: "reldef-podwide", workspaceId: null };

    await expect(makeRepo().delete("reldef-podwide")).resolves.toBeUndefined();
    expect(deleteCalls).toBe(1);
  });
});
