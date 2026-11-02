/**
 * `related_to` is READ, never WRITTEN (migration 0391's code half).
 *
 * `relates_to` is the relation the pod defines; `related_to` was a leftover
 * spelling. The AI relationship schema still accepts it (an emitter not yet
 * updated) and parses it to `relates_to`; both projectors that write
 * `entity_relationships` store the canonical spelling even when they are
 * handed the raw, unparsed legacy one (an event stored before this release).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../client-pg.js", () => {
  const chain = {
    values(v: Record<string, unknown>) {
      inserted.push(v);
      return { onConflictDoNothing: async () => undefined };
    },
  };
  return {
    db: { insert: () => chain },
    sql: { end: async () => undefined },
  };
});
// The package setup file cleans test users through a real connection; this
// file opens none.
vi.mock("./test-utils.js", () => ({ cleanTestData: async () => undefined }));

import {
  AIRelationshipMetadataSchema,
  canonicalRelationType,
  type SynapEvent,
} from "@synap-core/core";
import { projectEventMetadata } from "../projectors/metadata-projector.js";
import { projectEnrichmentEvent } from "../projectors/enrichment-projector.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  inserted.length = 0;
});

describe("canonicalRelationType", () => {
  it("rewrites the legacy spelling and passes every other type through", () => {
    expect(canonicalRelationType("related_to")).toBe("relates_to");
    expect(canonicalRelationType("relates_to")).toBe("relates_to");
    expect(canonicalRelationType("works_at")).toBe("works_at");
    expect(canonicalRelationType("toString")).toBe("toString");
  });
});

describe("AIRelationshipMetadataSchema", () => {
  const parse = (type: string) =>
    AIRelationshipMetadataSchema.safeParse({
      relationships: [{ targetEntityId: B, type, confidence: 0.9 }],
    });

  it("accepts a legacy `related_to` and parses it to `relates_to`", () => {
    const res = parse("related_to");
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.relationships[0]!.type).toBe("relates_to");
  });

  it("keeps refusing a type outside the vocabulary", () => {
    expect(parse("mentions_maybe").success).toBe(false);
  });
});

describe("the entity_relationships writers store the canonical spelling", () => {
  it("metadata projector, both directions of a bidirectional edge", async () => {
    await projectEventMetadata({
      id: "evt-1",
      type: "entities.create.completed",
      subjectId: A,
      userId: "u1",
      metadata: {
        ai: {
          agent: "test-agent",
          relationships: {
            relationships: [
              {
                targetEntityId: B,
                type: "related_to",
                confidence: 0.8,
                bidirectional: true,
              },
            ],
          },
        },
      },
    } as unknown as SynapEvent);
    const types = inserted.map((v) => v.relationshipType);
    expect(types).toEqual(["relates_to", "relates_to"]);
  });

  it("enrichment projector (relationship discovered event)", async () => {
    await projectEnrichmentEvent({
      id: "evt-2",
      type: "enrichment.entity.relationships.discovered",
      subjectId: A,
      userId: "u1",
      data: {
        sourceEntityId: A,
        targetEntityId: B,
        relationshipType: "related_to",
        discoveredBy: "test-agent",
        confidence: 0.7,
        bidirectional: false,
      },
    } as unknown as SynapEvent);
    expect(inserted.map((v) => v.relationshipType)).toEqual(["relates_to"]);
  });
});
