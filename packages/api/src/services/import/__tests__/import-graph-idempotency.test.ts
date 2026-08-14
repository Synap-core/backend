import { describe, it, expect, vi } from "vitest";

import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { computeImportGraphIdempotencyKey } from "../../../utils/pending-capture-dedup.js";
import {
  buildImportGraphProposalData,
  findPriorImportGraphProposal,
} from "../structuring.js";

/**
 * The `import.graph` duplicate hole, closed.
 *
 * Three of the four `import.graph` writers (proposeImportGraph / analyze /
 * analyzeLarge — all sharing `buildImportGraphProposalData`) stamped NO
 * `idempotencyKey`, and the dedup predicate is
 * `data ->> 'idempotencyKey' = $key` — which NEVER matches NULL. A keyless
 * proposal was therefore invisible to dedup in both directions, permanently
 * (14 of 29 pending rows on the live pod). The lane also never CALLED the
 * lookup, so stamping alone would have been inert.
 *
 * These tests pin both halves plus the two edge guards:
 *   - a degenerate (no create_entity) graph must NOT hash to a constant, and
 *     must NOT be stamped at all — an emitted null/"" key would make every
 *     keyless historical row a candidate match;
 *   - the lookup must not even be ISSUED for a degenerate graph.
 */

const entityOp = (
  over: Partial<Extract<CompositeProposalOperation, { op: "create_entity" }>>
): CompositeProposalOperation => ({
  op: "create_entity",
  ref: "e1",
  profileSlug: "person",
  title: "Ada Lovelace",
  properties: { email: "ada@example.com" },
  ...over,
});

describe("computeImportGraphIdempotencyKey", () => {
  const ops: CompositeProposalOperation[] = [
    entityOp({}),
    entityOp({ ref: "e2", profileSlug: "company", title: "Analytical Co" }),
    {
      op: "create_relation",
      type: "works_at",
      sourceRef: "e1",
      targetRef: "e2",
    },
  ];

  it("is deterministic — the same graph reproduces the same key", () => {
    const a = computeImportGraphIdempotencyKey({
      workspaceId: "ws-1",
      operations: ops,
    });
    const b = computeImportGraphIdempotencyKey({
      workspaceId: "ws-1",
      operations: ops,
    });
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it("changes when the CONTENT changes (two different imports never collide)", () => {
    const same = computeImportGraphIdempotencyKey({
      workspaceId: "ws-1",
      operations: ops,
    });
    const different = computeImportGraphIdempotencyKey({
      workspaceId: "ws-1",
      operations: [
        entityOp({ title: "Grace Hopper" }),
        entityOp({ ref: "e2", profileSlug: "company", title: "Analytical Co" }),
        {
          op: "create_relation",
          type: "works_at",
          sourceRef: "e1",
          targetRef: "e2",
        },
      ],
    });
    expect(different).not.toBe(same);
  });

  it("changes with the workspace/project lens", () => {
    const ws1 = computeImportGraphIdempotencyKey({
      workspaceId: "ws-1",
      operations: ops,
    });
    expect(
      computeImportGraphIdempotencyKey({ workspaceId: "ws-2", operations: ops })
    ).not.toBe(ws1);
    expect(
      computeImportGraphIdempotencyKey({
        workspaceId: "ws-1",
        projectId: "p-1",
        operations: ops,
      })
    ).not.toBe(ws1);
  });

  it("is operation-ORDER independent (a re-analyze may emit in a different order)", () => {
    const reversed = [...ops].reverse();
    expect(
      computeImportGraphIdempotencyKey({
        workspaceId: "ws-1",
        operations: reversed,
      })
    ).toBe(
      computeImportGraphIdempotencyKey({ workspaceId: "ws-1", operations: ops })
    );
  });

  it("EDGE: a degenerate graph (no create_entity) yields null, not a constant", () => {
    expect(
      computeImportGraphIdempotencyKey({ workspaceId: "ws-1", operations: [] })
    ).toBeNull();
    expect(
      computeImportGraphIdempotencyKey({
        workspaceId: "ws-1",
        operations: [
          {
            op: "create_relation",
            type: "works_at",
            sourceRef: "a",
            targetRef: "b",
          },
        ],
      })
    ).toBeNull();
    // …and two UNRELATED degenerate imports therefore share no key at all.
  });
});

describe("buildImportGraphProposalData", () => {
  it("STAMPS idempotencyKey — the missing line all 3 import writers shared", () => {
    const data = buildImportGraphProposalData({
      operations: [entityOp({})],
      source: "markdown",
      sourceId: "batch-1",
      workspaceId: "ws-1",
    });
    expect(typeof data.idempotencyKey).toBe("string");
    expect(data.idempotencyKey).toBe(
      computeImportGraphIdempotencyKey({
        workspaceId: "ws-1",
        operations: [entityOp({})],
      })
    );
  });

  it("does NOT vary with sourceId (a fresh UUID per run would break idempotency)", () => {
    const a = buildImportGraphProposalData({
      operations: [entityOp({})],
      source: "markdown",
      sourceId: "batch-1",
      workspaceId: "ws-1",
    });
    const b = buildImportGraphProposalData({
      operations: [entityOp({})],
      source: "markdown",
      sourceId: "batch-2",
      workspaceId: "ws-1",
    });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  it("EDGE: OMITS the key for a degenerate graph — never null/'' (a keyless legacy row must stay unmatchable)", () => {
    const data = buildImportGraphProposalData({
      operations: [],
      source: "markdown",
      sourceId: "batch-1",
      workspaceId: "ws-1",
    });
    expect("idempotencyKey" in data).toBe(false);
  });
});

describe("findPriorImportGraphProposal", () => {
  const stubDb = (rows: unknown[]) => {
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    return { db: { select } as never, select };
  };

  it("returns the PRIOR proposal on a content-key hit", async () => {
    const { db } = stubDb([{ id: "prop-prior", status: "pending" }]);
    const prior = await findPriorImportGraphProposal(
      { userId: "u1", workspaceId: "ws-1", operations: [entityOp({})] },
      db
    );
    expect(prior).toEqual({ id: "prop-prior", status: "pending" });
  });

  it("returns null when there is no prior proposal (a genuinely new import files)", async () => {
    const { db } = stubDb([]);
    expect(
      await findPriorImportGraphProposal(
        { userId: "u1", workspaceId: "ws-1", operations: [entityOp({})] },
        db
      )
    ).toBeNull();
  });

  it("EDGE: a degenerate graph issues NO query at all (can't false-match keyless rows)", async () => {
    const { db, select } = stubDb([{ id: "nope", status: "pending" }]);
    expect(
      await findPriorImportGraphProposal(
        { userId: "u1", workspaceId: "ws-1", operations: [] },
        db
      )
    ).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("is best-effort — a lookup failure falls through to filing fresh", async () => {
    const db = {
      select: () => {
        throw new Error("pg down");
      },
    } as never;
    expect(
      await findPriorImportGraphProposal(
        { userId: "u1", workspaceId: "ws-1", operations: [entityOp({})] },
        db
      )
    ).toBeNull();
  });
});
