/**
 * Regression: a materialize receipt must report relations CREATED, not
 * relations SUBMITTED. A capture with N submitted relations where M fail to
 * resolve/create must (a) return fewer than N in `relations`, and (b) name
 * every dropped relation on `relationsFailed` instead of only logging it.
 *
 * Root cause this pins: `createRelationsFromRefs` caught a per-relation
 * failure and only forwarded it to an optional `onError` log callback — the
 * caller's receipt still reported the SUBMITTED count, so a partial failure
 * was invisible to the user/agent that issued the capture.
 */

import { describe, it, expect, vi } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  createRelationsFromRefs,
  materializeCompositeGraph,
} from "./materialize-composite.js";

describe("createRelationsFromRefs — honest created count", () => {
  it("returns fewer relations than submitted when some fail, and reports each failure with its ref pair", async () => {
    const refToRealId = {
      a: "11111111-1111-1111-1111-111111111111",
      b: "22222222-2222-2222-2222-222222222222",
      c: "33333333-3333-3333-3333-333333333333",
    };
    const relationCaller = {
      // The a→b edge fails at the DB; a→c succeeds.
      create: vi.fn(async (input: { targetEntityId: string }) => {
        if (input.targetEntityId === refToRealId.b) {
          throw new Error("db write failed");
        }
        return { id: "rel-1" };
      }),
    };
    const onError = vi.fn();

    const relations = await createRelationsFromRefs(
      [
        { sourceRef: "a", targetRef: "b", type: "related_to" },
        { sourceRef: "a", targetRef: "c", type: "related_to" },
      ],
      refToRealId,
      relationCaller,
      { onError }
    );

    // 2 submitted, only 1 actually created.
    expect(relations).toHaveLength(1);
    expect(relations[0]?.targetEntityId).toBe(refToRealId.c);

    // The failure is named, not just logged: onError carries the RAW refs.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "related_to", {
      sourceRef: "a",
      targetRef: "b",
    });
  });
});

describe("materializeCompositeGraph — relations receipt", () => {
  const entityCaller = {
    create: vi.fn(async (input: { title?: string }) => ({
      id: `entity-${input.title}`,
    })),
  };

  it("relations.length is the CREATED count and relationsFailed names every dropped op", async () => {
    const relationCaller = {
      create: vi.fn().mockResolvedValue({ id: "rel-1" }),
    };

    const operations: CompositeProposalOperation[] = [
      { op: "create_entity", profileSlug: "person", title: "A", ref: "a" },
      { op: "create_entity", profileSlug: "person", title: "B", ref: "b" },
      // Resolves fine (a → b, both created above).
      {
        op: "create_relation",
        sourceRef: "a",
        targetRef: "b",
        type: "related_to",
      },
      // Unresolvable ref — resolveCompositeRef throws (never an in-batch ref,
      // never a UUID) — exactly the "submitted but never created" shape a
      // malformed capture graph produces.
      {
        op: "create_relation",
        sourceRef: "a",
        targetRef: "$op99",
        type: "related_to",
      },
    ];

    const result = await materializeCompositeGraph(
      operations,
      entityCaller,
      relationCaller
    );

    // 2 relation ops submitted, only 1 actually created — the receipt must
    // say 1, never 2.
    expect(result.relations).toHaveLength(1);
    expect(result.linked).toBe(1);

    // The dropped op is named on the receipt, not silently swallowed.
    expect(result.relationsFailed).toHaveLength(1);
    expect(result.relationsFailed[0]).toMatchObject({
      sourceRef: "a",
      targetRef: "$op99",
      type: "related_to",
    });
    expect(result.relationsFailed[0]?.reason).toMatch(/unknown reference/);
  });

  it("relationsFailed is empty when every relation resolves and creates", async () => {
    const relationCaller = {
      create: vi.fn().mockResolvedValue({ id: "rel-1" }),
    };
    const operations: CompositeProposalOperation[] = [
      { op: "create_entity", profileSlug: "person", title: "A", ref: "a" },
      { op: "create_entity", profileSlug: "person", title: "B", ref: "b" },
      {
        op: "create_relation",
        sourceRef: "a",
        targetRef: "b",
        type: "related_to",
      },
    ];

    const result = await materializeCompositeGraph(
      operations,
      entityCaller,
      relationCaller
    );

    expect(result.relations).toHaveLength(1);
    expect(result.relationsFailed).toEqual([]);
  });
});
