import { describe, it, expect, vi } from "vitest";

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  buildPropertyUnion,
  pickMergeWinner,
  planDocumentAction,
  isEmptyPropertyValue,
  countNonEmptyProperties,
  assertMergeablePair,
  assertUnmergeable,
} from "./entity-merge-service.js";
import type { Entity } from "../schema/entities.js";
import type { MergeMaterializedStamp } from "./entity-merge-service.js";

// ── isEmptyPropertyValue ─────────────────────────────────────────────────────

describe("isEmptyPropertyValue", () => {
  it("treats null/undefined/empty string as empty", () => {
    expect(isEmptyPropertyValue(null)).toBe(true);
    expect(isEmptyPropertyValue(undefined)).toBe(true);
    expect(isEmptyPropertyValue("")).toBe(true);
    expect(isEmptyPropertyValue("  ")).toBe(true);
  });

  it("treats 0, false, [], {} and non-empty strings as non-empty", () => {
    expect(isEmptyPropertyValue(0)).toBe(false);
    expect(isEmptyPropertyValue(false)).toBe(false);
    expect(isEmptyPropertyValue([])).toBe(false);
    expect(isEmptyPropertyValue({})).toBe(false);
    expect(isEmptyPropertyValue("x")).toBe(false);
  });
});

// ── buildPropertyUnion ───────────────────────────────────────────────────────

describe("buildPropertyUnion", () => {
  it("fills null/missing winner keys from loser", () => {
    const { merged, filled, conflicts } = buildPropertyUnion(
      { email: "a@x.com", phone: null, name: "" },
      { email: "a@x.com", phone: "+331", name: "Ada", notes: "hi" }
    );

    expect(merged).toEqual({
      email: "a@x.com",
      phone: "+331",
      name: "Ada",
      notes: "hi",
    });
    expect(filled.sort()).toEqual(["name", "notes", "phone"]);
    expect(conflicts).toEqual([]);
  });

  it("keeps winner value and records conflict when both non-empty differ", () => {
    const { merged, filled, conflicts } = buildPropertyUnion(
      { email: "a@x.com", role: "founder" },
      { email: "b@x.com", role: "founder" }
    );

    expect(merged.email).toBe("a@x.com");
    expect(merged.role).toBe("founder");
    expect(filled).toEqual([]);
    expect(conflicts).toEqual([
      { key: "email", winnerValue: "a@x.com", loserValue: "b@x.com" },
    ]);
  });

  it("does not conflict when both values are equal", () => {
    const { conflicts, filled } = buildPropertyUnion(
      { tags: ["a", "b"], n: 1 },
      { tags: ["a", "b"], n: 1 }
    );
    expect(conflicts).toEqual([]);
    expect(filled).toEqual([]);
  });

  it("ignores empty loser values", () => {
    const { merged, filled, conflicts } = buildPropertyUnion(
      { email: "a@x.com" },
      { email: "", phone: null, notes: "  " }
    );
    expect(merged).toEqual({ email: "a@x.com" });
    expect(filled).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("does not overwrite winner with loser on conflict", () => {
    const { merged } = buildPropertyUnion(
      { title: "Winner" },
      { title: "Loser" }
    );
    expect(merged.title).toBe("Winner");
  });
});

// ── pickMergeWinner ──────────────────────────────────────────────────────────

describe("pickMergeWinner", () => {
  const base = {
    createdAt: new Date("2024-01-01T00:00:00Z"),
    title: null as string | null,
  };

  it("prefers the entity with more non-empty properties", () => {
    const result = pickMergeWinner(
      {
        id: "aaa",
        ...base,
        properties: { email: "a@x.com" },
      },
      {
        id: "bbb",
        ...base,
        properties: { email: "b@x.com", phone: "+1", company: "Acme" },
      }
    );
    expect(result.winnerId).toBe("bbb");
    expect(result.loserId).toBe("aaa");
    expect(result.reason).toMatch(/more_non_empty_properties/);
  });

  it("breaks ties with older createdAt", () => {
    const result = pickMergeWinner(
      {
        id: "aaa",
        createdAt: new Date("2024-06-01T00:00:00Z"),
        properties: { email: "a@x.com" },
        title: null,
      },
      {
        id: "bbb",
        createdAt: new Date("2024-01-01T00:00:00Z"),
        properties: { email: "b@x.com" },
        title: null,
      }
    );
    expect(result.winnerId).toBe("bbb");
    expect(result.reason).toBe("older_created_at");
  });

  it("breaks remaining ties with stable id order", () => {
    const t = new Date("2024-01-01T00:00:00Z");
    const result = pickMergeWinner(
      { id: "zzz", createdAt: t, properties: {}, title: null },
      { id: "aaa", createdAt: t, properties: {}, title: null }
    );
    expect(result.winnerId).toBe("aaa");
    expect(result.loserId).toBe("zzz");
    expect(result.reason).toBe("stable_id_order");
  });
});

// ── countNonEmptyProperties ──────────────────────────────────────────────────

describe("countNonEmptyProperties", () => {
  it("counts only non-empty values", () => {
    expect(
      countNonEmptyProperties({
        a: "x",
        b: "",
        c: null,
        d: 0,
        e: undefined,
      })
    ).toBe(2); // a and d
  });
});

// ── planDocumentAction ───────────────────────────────────────────────────────

describe("planDocumentAction", () => {
  it("moves when winner has none and loser has one", () => {
    expect(planDocumentAction(null, "doc-1")).toBe("moved");
  });

  it("keeps both when both have documents", () => {
    expect(planDocumentAction("doc-w", "doc-l")).toBe("kept_both");
  });

  it("is none when neither has a document or only winner has one", () => {
    expect(planDocumentAction(null, null)).toBe("none");
    expect(planDocumentAction("doc-w", null)).toBe("none");
  });
});

// ── assertMergeablePair ──────────────────────────────────────────────────────

function entity(overrides: Partial<Entity> & { id: string }): Entity {
  return {
    userId: "user-1",
    workspaceId: "ws-1",
    profileId: null,
    type: "person",
    title: null,
    preview: null,
    documentId: null,
    properties: {},
    systemData: {},
    version: 1,
    createdByKind: null,
    createdByUserId: null,
    agentUserId: null,
    sourceProposalId: null,
    correlationId: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as Entity;
}

describe("assertMergeablePair", () => {
  it("accepts same type, same workspace, same user", () => {
    expect(() =>
      assertMergeablePair(entity({ id: "w" }), entity({ id: "l" }), "user-1")
    ).not.toThrow();
  });

  it("accepts both pod-wide (null workspace)", () => {
    expect(() =>
      assertMergeablePair(
        entity({ id: "w", workspaceId: null }),
        entity({ id: "l", workspaceId: null }),
        "user-1"
      )
    ).not.toThrow();
  });

  it("rejects same id", () => {
    expect(() =>
      assertMergeablePair(entity({ id: "x" }), entity({ id: "x" }), "user-1")
    ).toThrow(/itself/);
  });

  it("rejects soft-deleted winner or loser", () => {
    expect(() =>
      assertMergeablePair(
        entity({ id: "w", deletedAt: new Date() }),
        entity({ id: "l" }),
        "user-1"
      )
    ).toThrow(/soft-deleted/);
    expect(() =>
      assertMergeablePair(
        entity({ id: "w" }),
        entity({ id: "l", deletedAt: new Date() }),
        "user-1"
      )
    ).toThrow(/soft-deleted/);
  });

  it("rejects different kinds", () => {
    expect(() =>
      assertMergeablePair(
        entity({ id: "w", type: "person" }),
        entity({ id: "l", type: "company" }),
        "user-1"
      )
    ).toThrow(/different kinds/);
  });

  it("rejects different workspaces", () => {
    expect(() =>
      assertMergeablePair(
        entity({ id: "w", workspaceId: "ws-a" }),
        entity({ id: "l", workspaceId: "ws-b" }),
        "user-1"
      )
    ).toThrow(/across workspaces/);
  });

  it("rejects workspace vs pod-wide", () => {
    expect(() =>
      assertMergeablePair(
        entity({ id: "w", workspaceId: "ws-a" }),
        entity({ id: "l", workspaceId: null }),
        "user-1"
      )
    ).toThrow(/across workspaces/);
  });

  it("rejects different owners", () => {
    expect(() =>
      assertMergeablePair(
        entity({ id: "w", userId: "user-1" }),
        entity({ id: "l", userId: "user-2" }),
        "user-1"
      )
    ).toThrow(/different users/);
  });

  it("rejects when caller userId does not match owners", () => {
    expect(() =>
      assertMergeablePair(
        entity({ id: "w", userId: "user-1" }),
        entity({ id: "l", userId: "user-1" }),
        "user-other"
      )
    ).toThrow(/does not match entity owners/);
  });
});

// ── assertUnmergeable ────────────────────────────────────────────────────────

const completeStamp = (): MergeMaterializedStamp => ({
  movedSignalIds: [],
  movedExternalLinkIds: [],
  movedFacetIds: [],
  rewiredRelations: [],
  documentMoved: false,
});

describe("assertUnmergeable", () => {
  it("accepts a complete stamp + snapshot", () => {
    expect(() =>
      assertUnmergeable({
        winnerId: "w",
        loserId: "l",
        previousWinnerSnapshot: { title: "W", properties: {} },
        materialized: completeStamp(),
      })
    ).not.toThrow();
  });

  it("rejects missing previousWinnerSnapshot", () => {
    expect(() =>
      assertUnmergeable({
        winnerId: "w",
        loserId: "l",
        // @ts-expect-error intentional incomplete input
        previousWinnerSnapshot: undefined,
        materialized: completeStamp(),
      })
    ).toThrow(/previousWinnerSnapshot/);
  });

  it("rejects missing materialized stamp", () => {
    expect(() =>
      assertUnmergeable({
        winnerId: "w",
        loserId: "l",
        previousWinnerSnapshot: { title: "W" },
        // @ts-expect-error intentional incomplete input
        materialized: null,
      })
    ).toThrow(/materialized/);
  });

  it("rejects legacy stamp with only rewiredRelationIds (no rewiredRelations)", () => {
    expect(() =>
      assertUnmergeable({
        winnerId: "w",
        loserId: "l",
        previousWinnerSnapshot: { title: "W" },
        materialized: {
          movedSignalIds: [],
          movedExternalLinkIds: [],
          movedFacetIds: [],
          // missing rewiredRelations
          documentMoved: false,
        } as unknown as MergeMaterializedStamp,
      })
    ).toThrow(/rewiredRelations/);
  });

  it("rejects same winner and loser id", () => {
    expect(() =>
      assertUnmergeable({
        winnerId: "x",
        loserId: "x",
        previousWinnerSnapshot: { title: "X" },
        materialized: completeStamp(),
      })
    ).toThrow(/itself/);
  });
});
