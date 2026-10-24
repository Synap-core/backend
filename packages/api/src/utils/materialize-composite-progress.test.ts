/**
 * THE MATERIALIZER REPORTS HOW FAR IT GOT — one settle per record and per
 * connection, and `done` reaches `total` exactly once, at the end.
 *
 * A background approval (`services/proposals/approval-runs.ts`) persists these
 * snapshots as the toast's "Creating records: 1,240 of 4,222". Driven through
 * the real `materializeCompositeGraph` with in-memory doors: what is asserted
 * is the VALUE each settle carries, not that a callback exists.
 *
 * NOT covered here: config / plan / update operations, which settle together
 * in the final `finishing` snapshot (counted only in `done`).
 */

import { describe, it, expect } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  materializeCompositeGraph,
  type MaterializeProgress,
} from "./materialize-composite.js";

let nextId = 0;
const entityCaller = {
  create: async () => ({ status: "created", id: `ent-${++nextId}` }),
};
const relationCaller = {
  create: async (input: { type: string }) => {
    if (input.type === "broken") throw new Error("Unknown relation type");
    return { status: "created", id: `rel-${++nextId}` };
  },
};

const GRAPH = [
  { op: "create_entity", ref: "a", profileSlug: "person", title: "Ada" },
  { op: "create_entity", ref: "b", profileSlug: "company", title: "Acme" },
  // Resolves onto a record that already exists: linked, not created.
  {
    op: "create_entity",
    ref: "c",
    profileSlug: "company",
    title: "Known",
    existingEntityId: "11111111-1111-4111-8111-111111111111",
  },
  { op: "create_relation", sourceRef: "a", targetRef: "b", type: "works_at" },
  { op: "create_relation", sourceRef: "a", targetRef: "c", type: "broken" },
] as CompositeProposalOperation[];

async function run(): Promise<MaterializeProgress[]> {
  const seen: MaterializeProgress[] = [];
  await materializeCompositeGraph(
    GRAPH,
    entityCaller as never,
    relationCaller as never,
    () => {},
    { onProgress: (p) => void seen.push(p) }
  );
  return seen;
}

describe("materializeCompositeGraph onProgress", () => {
  it("settles each record, then each connection, then finishes at total", async () => {
    const seen = await run();
    expect(seen.map((p) => [p.phase, p.done])).toEqual([
      ["entities", 1],
      ["entities", 2],
      ["entities", 3],
      ["relations", 4],
      ["relations", 5],
      ["finishing", 5],
    ]);
    expect(seen.every((p) => p.total === 5)).toBe(true);
  });

  it("counts created, linked and failed as they land", async () => {
    const seen = await run();
    const afterEntities = seen[2]!;
    expect(afterEntities).toMatchObject({ created: 2, linked: 1, failed: 0 });
    const last = seen[seen.length - 1]!;
    // works_at created; the broken edge failed (and is on relationsFailed).
    expect(last).toMatchObject({ created: 3, linked: 1, failed: 1 });
  });

  it("without onProgress nothing is counted and the result is unchanged", async () => {
    const result = await materializeCompositeGraph(
      GRAPH,
      entityCaller as never,
      relationCaller as never
    );
    expect(result.created).toBe(2);
    expect(result.relationsFailed).toHaveLength(1);
  });
});
