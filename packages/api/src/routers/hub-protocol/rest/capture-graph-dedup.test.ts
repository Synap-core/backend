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

  it("collapses a person whose alias matches another person's title (0scr → Oscar Piveteau)", () => {
    const entities: CaptureGraphEntity[] = [
      { ref: "p1", profileSlug: "person", title: "Oscar Piveteau" },
      {
        ref: "p2",
        profileSlug: "person",
        title: "0scr",
        properties: { aliases: ["Oscar Piveteau"] },
      },
    ];
    const relations: CaptureGraphRelation[] = [
      { sourceRef: "p2", targetRef: "company-x", type: "works_at" },
    ];

    const result = collapseDuplicateEntities(entities, relations, []);

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.ref).toBe("p1");
    // The dropped ref's relation is rewired to the survivor.
    expect(result.relations).toEqual([
      { sourceRef: "p1", targetRef: "company-x", type: "works_at" },
    ]);
  });

  it("collapses regardless of order when the alias-carrier comes first", () => {
    const entities: CaptureGraphEntity[] = [
      {
        ref: "p2",
        profileSlug: "person",
        title: "0scr",
        properties: { aliases: ["Oscar Piveteau"] },
      },
      { ref: "p1", profileSlug: "person", title: "Oscar Piveteau" },
    ];

    const result = collapseDuplicateEntities(entities, [], []);

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.ref).toBe("p2");
  });

  it("does NOT collapse two people sharing only an email (shared inbox risk)", () => {
    // `email` is intentionally NOT an auto-merge signal — a shared/generic inbox
    // (support@, hello@) must not silently merge two different people. They stay
    // separate; a real same-person link is driven by discord-handle/alias instead.
    const entities: CaptureGraphEntity[] = [
      {
        ref: "p1",
        profileSlug: "person",
        title: "Oscar",
        properties: { email: "team@x.com" },
      },
      {
        ref: "p2",
        profileSlug: "person",
        title: "Priya",
        properties: { email: "Team@X.com" },
      },
    ];

    const result = collapseDuplicateEntities(entities, [], []);

    expect(result.entities).toHaveLength(2);
  });

  it("collapses two people sharing a discord-handle (case-folded)", () => {
    const entities: CaptureGraphEntity[] = [
      {
        ref: "p1",
        profileSlug: "person",
        title: "Oscar Piveteau",
        properties: { "discord-handle": "0scr" },
      },
      {
        ref: "p2",
        profileSlug: "person",
        title: "0scr",
        properties: { "discord-handle": "0SCR" },
      },
    ];

    const result = collapseDuplicateEntities(entities, [], []);

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.ref).toBe("p1");
  });

  it("does not collapse an alias match across different profile slugs", () => {
    const entities: CaptureGraphEntity[] = [
      { ref: "p1", profileSlug: "person", title: "Oscar Piveteau" },
      {
        ref: "c1",
        profileSlug: "company",
        title: "Acme",
        properties: { aliases: ["Oscar Piveteau"] },
      },
    ];

    const result = collapseDuplicateEntities(entities, [], []);

    expect(result.entities).toHaveLength(2);
  });
});
