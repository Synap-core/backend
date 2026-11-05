/**
 * capture-graph-hold — the pure half of A4: which ops file now, which are
 * held, and how the held proposal links to what already landed.
 */
import { describe, it, expect } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  assertNoHeldItemAutoApplies,
  buildHeldCaptureItem,
  buildHeldProposalOperations,
  landingWorkspaceOf,
  splitHeldItems,
} from "./capture-graph-hold.js";

const FOUNDATION = "11111111-1111-4111-8111-111111111111";
const ECOSYSTEM = "22222222-2222-4222-8222-222222222222";
const EXISTING = "33333333-3333-4333-8333-333333333333";

const ops = (list: unknown[]): CompositeProposalOperation[] => list as never;

const GRAPH = ops([
  { op: "create_entity", ref: "p1", profileSlug: "pain-point", title: "P1" },
  { op: "create_entity", ref: "t", profileSlug: "trend", title: "T" },
  { op: "create_entity", ref: "p2", profileSlug: "pain-point", title: "P2" },
  {
    op: "create_relation",
    type: "relates_to",
    sourceRef: "p1",
    targetRef: "t",
  },
  // Positional refs: $op1 is `t`, $op2 is `p2` — both shift once `t` leaves.
  {
    op: "create_relation",
    type: "supports",
    sourceRef: "$op1",
    targetRef: "$op2",
  },
  {
    op: "create_relation",
    type: "relates_to",
    sourceRef: "$primary",
    targetRef: "$op2",
  },
  {
    op: "create_relation",
    type: "mentions",
    sourceRef: "t",
    targetRef: EXISTING,
  },
]);

describe("landingWorkspaceOf", () => {
  it("is the op's pin, else the graph's space (the create door's lens)", () => {
    expect(
      landingWorkspaceOf({ targetWorkspaceId: ECOSYSTEM }, FOUNDATION)
    ).toBe(ECOSYSTEM);
    expect(landingWorkspaceOf({}, FOUNDATION)).toBe(FOUNDATION);
    expect(landingWorkspaceOf({}, null)).toBeNull();
  });
});

describe("splitHeldItems", () => {
  it("files the siblings and the relations that do not touch the held item", () => {
    const split = splitHeldItems(GRAPH, new Set(["t"]));
    if (!split.splittable) throw new Error(split.reason);
    expect(split.applyOps).toEqual([
      GRAPH[0],
      GRAPH[2],
      // `$primary`/`$op2` written as op refs, so they survive the removal.
      {
        op: "create_relation",
        type: "relates_to",
        sourceRef: "p1",
        targetRef: "p2",
      },
    ]);
    expect(split.heldEntityOps).toEqual([GRAPH[1]]);
    expect(split.heldRelations).toEqual([
      {
        op: "create_relation",
        type: "relates_to",
        sourceRef: "p1",
        targetRef: "t",
      },
      {
        op: "create_relation",
        type: "supports",
        sourceRef: "t",
        targetRef: "p2",
      },
      {
        op: "create_relation",
        type: "mentions",
        sourceRef: "t",
        targetRef: EXISTING,
      },
    ]);
  });

  it("does not split when every item is held, or a plan, or a role points at it", () => {
    expect(splitHeldItems(GRAPH, new Set(["p1", "t", "p2"])).splittable).toBe(
      false
    );
    const plan = ops([
      ...GRAPH,
      { op: "create_session", ref: "s1", title: "Do it" },
    ]);
    expect(splitHeldItems(plan, new Set(["t"])).splittable).toBe(false);
    const role = ops([
      GRAPH[1]!,
      {
        op: "create_entity",
        ref: "p1",
        profileSlug: "person",
        facets: [{ profileSlug: "member", contextRef: "t" }],
      },
    ]);
    expect(splitHeldItems(role, new Set(["t"])).splittable).toBe(false);
    expect(splitHeldItems(GRAPH, new Set()).splittable).toBe(false);
  });
});

describe("buildHeldProposalOperations", () => {
  it("writes landed endpoints as their real ids and drops what has none", () => {
    const split = splitHeldItems(GRAPH, new Set(["t"]));
    if (!split.splittable) throw new Error(split.reason);
    const P1 = "44444444-4444-4444-8444-444444444444";
    // p2 did not land: its relation cannot be carried.
    const { operations, dropped } = buildHeldProposalOperations(
      split,
      new Map([["p1", P1]])
    );
    expect(operations).toEqual([
      GRAPH[1],
      {
        op: "create_relation",
        type: "relates_to",
        sourceRef: P1,
        targetRef: "t",
      },
      {
        op: "create_relation",
        type: "mentions",
        sourceRef: "t",
        targetRef: EXISTING,
      },
    ]);
    expect(dropped).toEqual([
      {
        op: "create_relation",
        type: "supports",
        sourceRef: "t",
        targetRef: "p2",
      },
    ]);
  });
});

describe("assertNoHeldItemAutoApplies (the A4 tripwire)", () => {
  it("throws when a held item is handed to the materializer", () => {
    expect(() => assertNoHeldItemAutoApplies(GRAPH, new Set(["t"]))).toThrow(
      /item "t" \(trend\)/
    );
    const split = splitHeldItems(GRAPH, new Set(["t"]));
    if (!split.splittable) throw new Error(split.reason);
    expect(() =>
      assertNoHeldItemAutoApplies(split.applyOps, new Set(["t"]))
    ).not.toThrow();
  });
});

describe("buildHeldCaptureItem", () => {
  it("names the kind, the space, where it exists, and the fix", () => {
    const item = buildHeldCaptureItem({
      ref: "t",
      label: "Agent-memory users now demand deletion",
      profileSlug: "trend",
      workspaceId: FOUNDATION,
      kindMissing: {
        profileSlug: "trend",
        kindName: "Trend",
        workspaceId: FOUNDATION,
        workspaceName: "Foundation",
        foundIn: [{ workspaceId: ECOSYSTEM, name: "Ecosystem" }],
      },
    });
    expect(item.suggestions).toEqual([
      {
        action: "file_in_workspace",
        workspaceId: ECOSYSTEM,
        name: "Ecosystem",
      },
    ]);
    expect(item.message).toBe(
      `"Agent-memory users now demand deletion" is held for review: the kind "Trend" isn't available in Foundation. It exists in Ecosystem. To file it, set targetWorkspaceId to Ecosystem (${ECOSYSTEM}), or use a kind that exists in Foundation.`
    );
  });

  it("says what to do when the kind exists nowhere the caller can see", () => {
    const item = buildHeldCaptureItem({
      ref: "s",
      label: "S",
      profileSlug: "signal",
      workspaceId: FOUNDATION,
      kindMissing: {
        profileSlug: "signal",
        workspaceId: FOUNDATION,
        workspaceName: "Foundation",
        foundIn: [],
      },
    });
    expect(item.suggestions).toEqual([]);
    expect(item.message).toBe(
      `"S" is held for review: the kind "signal" isn't available in Foundation. To file it, use a kind that exists in Foundation, or define this kind there first.`
    );
  });
});
