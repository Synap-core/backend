/**
 * Unit cover for the PURE half of pending-capture dedup — the content-hash
 * idempotency key. This is the load-bearing claim of the anti-duplicate fix:
 * a byte-identical re-submit must reproduce the SAME key (so the retry resolves
 * to the prior proposal), and two genuinely-different captures must NOT collide
 * (so distinct work is never silently merged). The DB-touching halves
 * (findPendingSignalMatches / findPriorCaptureGraphProposal) need live Postgres
 * and are exercised in the capture integration path, not here.
 */

import { describe, it, expect } from "vitest";
import { computeCaptureGraphIdempotencyKey } from "./pending-capture-dedup.js";

const base = {
  workspaceId: "ws-1",
  projectId: null,
  entities: [
    {
      profileSlug: "company",
      title: "Talentir",
      properties: { website: "talentir.io" },
    },
    {
      profileSlug: "person",
      title: "Ada",
      properties: { email: "ada@talentir.io" },
    },
  ],
  relations: [{ sourceRef: "e1", targetRef: "e2", type: "works_at" }],
};

describe("computeCaptureGraphIdempotencyKey", () => {
  it("is stable: identical content → identical key (the re-submit case)", () => {
    expect(computeCaptureGraphIdempotencyKey(base)).toBe(
      computeCaptureGraphIdempotencyKey(base)
    );
  });

  it("is order-independent in entities and property keys (producer order must not matter)", () => {
    const reordered = {
      ...base,
      entities: [
        // entities in the other order, property keys in the other order
        {
          profileSlug: "person",
          properties: { email: "ada@talentir.io" },
          title: "Ada",
        },
        {
          profileSlug: "company",
          properties: { website: "talentir.io" },
          title: "Talentir",
        },
      ],
    };
    expect(computeCaptureGraphIdempotencyKey(reordered)).toBe(
      computeCaptureGraphIdempotencyKey(base)
    );
  });

  it("changes when any content field changes (a real difference must not collide)", () => {
    const key = computeCaptureGraphIdempotencyKey(base);
    // different property value
    expect(
      computeCaptureGraphIdempotencyKey({
        ...base,
        entities: [
          {
            profileSlug: "company",
            title: "Talentir",
            properties: { website: "OTHER.io" },
          },
          base.entities[1],
        ],
      })
    ).not.toBe(key);
    // different relation
    expect(
      computeCaptureGraphIdempotencyKey({
        ...base,
        relations: [{ sourceRef: "e1", targetRef: "e2", type: "founded" }],
      })
    ).not.toBe(key);
    // different scope
    expect(
      computeCaptureGraphIdempotencyKey({ ...base, workspaceId: "ws-2" })
    ).not.toBe(key);
    // an added entity
    expect(
      computeCaptureGraphIdempotencyKey({
        ...base,
        entities: [...base.entities, { profileSlug: "note", title: "x" }],
      })
    ).not.toBe(key);
    // a changed description (a folded field the base fixture didn't exercise)
    expect(
      computeCaptureGraphIdempotencyKey({
        ...base,
        entities: [
          { ...base.entities[0], description: "series A fintech" },
          base.entities[1],
        ],
      })
    ).not.toBe(key);
    // a changed long-form content body
    expect(
      computeCaptureGraphIdempotencyKey({
        ...base,
        entities: [
          { ...base.entities[0], content: "# Notes\nmet at conf" },
          base.entities[1],
        ],
      })
    ).not.toBe(key);
  });

  it("distinguishes an extra channel binding from an exact re-submit", () => {
    expect(
      computeCaptureGraphIdempotencyKey({ ...base, bindings: [{}] })
    ).not.toBe(computeCaptureGraphIdempotencyKey(base));
  });
});
