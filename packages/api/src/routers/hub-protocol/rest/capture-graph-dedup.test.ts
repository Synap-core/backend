/**
 * capture-graph-dedup.ts — within-batch entity collapse tests.
 *
 * Covers the gap the persisted-dedup block (in capture.ts) can't: two refs
 * in the SAME /capture/graph batch describing the same (profileSlug, title)
 * with neither pinned via existingEntityId yet.
 */

import { describe, it, expect } from "vitest";

import {
  collapseDuplicateEntities,
  type CaptureGraphEntity,
  type CaptureGraphRelation,
  type CaptureGraphBinding,
} from "./capture-graph-dedup.js";

describe("collapseDuplicateEntities", () => {
  it("collapses two refs with the same (profileSlug, title) — first wins", () => {
    const entities: CaptureGraphEntity[] = [
      { ref: "person-1", profileSlug: "contact", title: "Jane Doe" },
      { ref: "person-2", profileSlug: "contact", title: "Jane Doe" },
    ];

    const result = collapseDuplicateEntities(entities, [], []);

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.ref).toBe("person-1");
  });

  it("rewrites relations' sourceRef and targetRef pointing at the dropped ref", () => {
    const entities: CaptureGraphEntity[] = [
      { ref: "person-1", profileSlug: "contact", title: "Jane Doe" },
      { ref: "person-2", profileSlug: "contact", title: "Jane Doe" },
      { ref: "company-1", profileSlug: "company", title: "Acme" },
    ];
    const relations: CaptureGraphRelation[] = [
      { sourceRef: "person-2", targetRef: "company-1", type: "works_at" },
      { sourceRef: "company-1", targetRef: "person-2", type: "employs" },
    ];

    const result = collapseDuplicateEntities(entities, relations, []);

    expect(result.relations).toEqual([
      { sourceRef: "person-1", targetRef: "company-1", type: "works_at" },
      { sourceRef: "company-1", targetRef: "person-1", type: "employs" },
    ]);
  });

  it("rewrites bindings' entityRef pointing at the dropped ref", () => {
    const entities: CaptureGraphEntity[] = [
      { ref: "person-1", profileSlug: "contact", title: "Jane Doe" },
      { ref: "person-2", profileSlug: "contact", title: "Jane Doe" },
    ];
    const bindings: CaptureGraphBinding[] = [
      { externalChannelId: "chan-1", entityRef: "person-2" },
    ];

    const result = collapseDuplicateEntities(entities, [], bindings);

    expect(result.bindings).toEqual([
      { externalChannelId: "chan-1", entityRef: "person-1" },
    ]);
  });

  it("drops a relation that becomes a self-loop after collapse", () => {
    const entities: CaptureGraphEntity[] = [
      { ref: "person-1", profileSlug: "contact", title: "Jane Doe" },
      { ref: "person-2", profileSlug: "contact", title: "Jane Doe" },
    ];
    const relations: CaptureGraphRelation[] = [
      { sourceRef: "person-1", targetRef: "person-2", type: "duplicate_of" },
    ];

    const result = collapseDuplicateEntities(entities, relations, []);

    expect(result.relations).toEqual([]);
  });

  it("never collapses entities that already have existingEntityId, even with the same (profileSlug, title)", () => {
    const entities: CaptureGraphEntity[] = [
      {
        ref: "person-1",
        profileSlug: "contact",
        title: "Jane Doe",
        existingEntityId: "real-id-1",
      },
      {
        ref: "person-2",
        profileSlug: "contact",
        title: "Jane Doe",
        existingEntityId: "real-id-2",
      },
    ];

    const result = collapseDuplicateEntities(entities, [], []);

    expect(result.entities).toHaveLength(2);
    expect(result.entities.map((e) => e.ref)).toEqual(["person-1", "person-2"]);
  });

  it("does not collapse entities with different titles or different profileSlug", () => {
    const entities: CaptureGraphEntity[] = [
      { ref: "person-1", profileSlug: "contact", title: "Jane Doe" },
      { ref: "person-2", profileSlug: "contact", title: "John Doe" },
      { ref: "person-3", profileSlug: "lead", title: "Jane Doe" },
    ];

    const result = collapseDuplicateEntities(entities, [], []);

    expect(result.entities).toHaveLength(3);
  });
});
