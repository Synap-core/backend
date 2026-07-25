/**
 * Unit cover for the RECALL half of pending loop-closure (Wave 3): the pure
 * text-match logic behind `findPendingTextMatches`, plus a structural check
 * that its DB query carries the mandatory OWNER FLOOR.
 *
 * The DB round-trip itself needs live Postgres (exercised in the ask/recall
 * integration path) — but the scoring, the query-term reduction, the
 * best-op-per-proposal selection, and the WHERE predicate are all inspectable
 * without PG, and they are the load-bearing claims:
 *   - a recall term that matches a pending title surfaces that proposal;
 *   - a non-matching query surfaces nothing (recall must not over-report);
 *   - the scan is floored on `created_by` (never a teammate's review queue).
 */

import { describe, it, expect } from "vitest";
import { proposals } from "@synap/database";
import {
  extractQueryTerms,
  scorePendingText,
  findPendingTextMatches,
} from "./pending-capture-dedup.js";

describe("extractQueryTerms", () => {
  it("reduces a query to lowercased content terms, filler stripped", () => {
    // "show", "me", "all", "the" are filler; "who"/"is" are interrogative/stop.
    expect(extractQueryTerms("Show me all the Talentir deals")).toEqual([
      "talentir",
      "deals",
    ]);
  });

  it("drops single-char noise (a stray letter would substring-match everything)", () => {
    expect(extractQueryTerms("a x Talentir")).toEqual(["talentir"]);
  });

  it("returns nothing for a pure-filler query", () => {
    // Every word is in the shared stopword/interrogative/imperative filler.
    expect(extractQueryTerms("show me all my")).toEqual([]);
  });
});

describe("scorePendingText", () => {
  it("counts DISTINCT query terms present across the op + summary haystack", () => {
    const score = scorePendingText(["talentir", "fintech"], {
      title: "Talentir",
      profileSlug: "company",
      summary: "A fintech startup captured from a call",
    });
    expect(score).toBe(2);
  });

  it("does not double-count a term repeated across fields", () => {
    expect(
      scorePendingText(["talentir"], {
        title: "Talentir",
        summary: "Talentir Talentir Talentir",
      })
    ).toBe(1);
  });

  it("scores 0 when no term appears, and 0 for an empty term list", () => {
    expect(scorePendingText(["acme"], { title: "Talentir" })).toBe(0);
    expect(scorePendingText([], { title: "Talentir" })).toBe(0);
  });
});

/**
 * A minimal chainable stand-in for the drizzle query builder: it records the
 * `where` predicate (so we can prove the owner floor) and resolves the terminal
 * `limit(...)` to whatever rows we preset — no Postgres involved.
 */
function mockDb(rows: unknown[]) {
  const captured: { where?: unknown } = {};
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          captured.where = cond;
          return {
            orderBy: () => ({
              limit: async () => rows,
            }),
          };
        },
      }),
    }),
  };
  return { db, captured };
}

/** Walk a drizzle SQL node's queryChunks, collecting every referenced column name. */
function collectColumnNames(
  node: unknown,
  acc = new Set<string>()
): Set<string> {
  if (!node || typeof node !== "object") return acc;
  const n = node as { name?: unknown; queryChunks?: unknown };
  if (typeof n.name === "string") acc.add(n.name);
  if (Array.isArray(n.queryChunks))
    for (const c of n.queryChunks) collectColumnNames(c, acc);
  return acc;
}

describe("findPendingTextMatches", () => {
  const pendingRow = {
    id: "prop-1",
    proposalType: "capture.graph",
    createdAt: new Date(),
    data: {
      summary: "Captured Talentir, a fintech, from a call",
      operations: [
        {
          op: "create_entity",
          ref: "$op0",
          profileSlug: "company",
          title: "Talentir",
        },
        {
          op: "create_entity",
          ref: "$op1",
          profileSlug: "person",
          title: "Ada Lovelace",
        },
        {
          op: "create_relation",
          type: "works_at",
          sourceRef: "$op1",
          targetRef: "$op0",
        },
      ],
    },
  };

  it("surfaces a pending proposal whose entity title matches the query", async () => {
    const { db } = mockDb([pendingRow]);
    const matches = await findPendingTextMatches(db as never, {
      userId: "user-1",
      query: "Talentir",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      proposalId: "prop-1",
      proposalType: "capture.graph",
      entityTitle: "Talentir",
      profileSlug: "company",
    });
    // Advisory-only fields the pending block relies on.
    expect(matches[0].reviewUrl).toContain("/open/prop-1");
    expect(matches[0].score).toBeGreaterThan(0);
  });

  it("picks the best-matching op as the representative entity", async () => {
    const { db } = mockDb([pendingRow]);
    const matches = await findPendingTextMatches(db as never, {
      userId: "user-1",
      query: "Ada",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].entityTitle).toBe("Ada Lovelace");
    expect(matches[0].profileSlug).toBe("person");
  });

  it("returns nothing when no term matches (recall must not over-report)", async () => {
    const { db } = mockDb([pendingRow]);
    const matches = await findPendingTextMatches(db as never, {
      userId: "user-1",
      query: "Acme Corporation",
    });
    expect(matches).toEqual([]);
  });

  it("returns nothing for a pure-filler query without hitting the DB", async () => {
    const { db, captured } = mockDb([pendingRow]);
    const matches = await findPendingTextMatches(db as never, {
      userId: "user-1",
      query: "show me all",
    });
    expect(matches).toEqual([]);
    // No terms → short-circuits before building/running any query.
    expect(captured.where).toBeUndefined();
  });

  it("floors the scan on created_by (never a teammate's review queue)", async () => {
    const { db, captured } = mockDb([pendingRow]);
    await findPendingTextMatches(db as never, {
      userId: "user-1",
      query: "Talentir",
    });
    const cols = collectColumnNames(captured.where);
    expect(cols.has(proposals.createdBy.name)).toBe(true);
    expect(proposals.createdBy.name).toBe("created_by");
    // and STRICT status pending rides in the same predicate.
    expect(cols.has(proposals.status.name)).toBe(true);
  });
});
