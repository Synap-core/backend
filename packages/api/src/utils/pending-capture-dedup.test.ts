import { describe, it, expect } from "vitest";

import { computeCaptureGraphIdempotencyKey } from "./pending-capture-dedup.js";

/**
 * Wave 1 anti-duplicate core — unit coverage for the retry half (the pending
 * scan moved to the duplicate door, `services/duplicates/`, with its tests):
 *
 *  - `computeCaptureGraphIdempotencyKey`: the content hash that makes a re-submit
 *    idempotent. The load-bearing claim is "two genuinely-different captures
 *    can't collide" — proven here by asserting every content dimension changes
 *    the key, while a byte-identical (or key-reordered) graph reproduces it.
 */

describe("computeCaptureGraphIdempotencyKey", () => {
  const base = {
    workspaceId: "ws-1" as string | null,
    projectId: null as string | null,
    entities: [
      {
        profileSlug: "person",
        title: "Ada Lovelace",
        properties: { email: "ada@example.com", role: "eng" },
      },
    ],
    relations: [],
    bindings: [],
  };

  it("is deterministic — the same graph reproduces the same key", () => {
    expect(computeCaptureGraphIdempotencyKey(base)).toBe(
      computeCaptureGraphIdempotencyKey(base)
    );
  });

  it("is property-ORDER independent (a retry may serialize keys differently)", () => {
    const reordered = {
      ...base,
      entities: [
        {
          profileSlug: "person",
          title: "Ada Lovelace",
          properties: { role: "eng", email: "ada@example.com" },
        },
      ],
    };
    expect(computeCaptureGraphIdempotencyKey(reordered)).toBe(
      computeCaptureGraphIdempotencyKey(base)
    );
  });

  it("DIFFERS when a property value differs (different capture → different key)", () => {
    const changed = {
      ...base,
      entities: [
        {
          profileSlug: "person",
          title: "Ada Lovelace",
          properties: { email: "grace@example.com", role: "eng" },
        },
      ],
    };
    expect(computeCaptureGraphIdempotencyKey(changed)).not.toBe(
      computeCaptureGraphIdempotencyKey(base)
    );
  });

  it("DIFFERS on title, profileSlug, workspace, project, and relations", () => {
    const key = computeCaptureGraphIdempotencyKey(base);
    expect(
      computeCaptureGraphIdempotencyKey({
        ...base,
        entities: [{ ...base.entities[0], title: "Grace Hopper" }],
      })
    ).not.toBe(key);
    expect(
      computeCaptureGraphIdempotencyKey({
        ...base,
        entities: [{ ...base.entities[0], profileSlug: "company" }],
      })
    ).not.toBe(key);
    expect(
      computeCaptureGraphIdempotencyKey({ ...base, workspaceId: "ws-2" })
    ).not.toBe(key);
    expect(
      computeCaptureGraphIdempotencyKey({ ...base, projectId: "proj-1" })
    ).not.toBe(key);
    expect(
      computeCaptureGraphIdempotencyKey({
        ...base,
        relations: [{ sourceRef: "e0", targetRef: "e1", type: "knows" }],
      })
    ).not.toBe(key);
  });

  it("is entity-ORDER independent WITH relations (LLM re-emits same graph, refs shift)", () => {
    // Same semantic graph — "Ada knows Grace" — but the two entities land in a
    // different order across attempts, so the LLM assigns them opposite refs.
    // Before content-addressing the relation endpoints, the raw-ref relation
    // ("t1 t2" vs "t2 t1") made the key differ → a duplicate slipped through.
    const g1 = {
      workspaceId: "ws-1" as string | null,
      projectId: null as string | null,
      bindings: [],
      entities: [
        { ref: "t1", profileSlug: "person", title: "Ada", properties: {} },
        { ref: "t2", profileSlug: "person", title: "Grace", properties: {} },
      ],
      relations: [{ sourceRef: "t1", targetRef: "t2", type: "knows" }], // Ada→Grace
    };
    const g2 = {
      ...g1,
      entities: [
        { ref: "t1", profileSlug: "person", title: "Grace", properties: {} },
        { ref: "t2", profileSlug: "person", title: "Ada", properties: {} },
      ],
      relations: [{ sourceRef: "t2", targetRef: "t1", type: "knows" }], // still Ada→Grace
    };
    expect(computeCaptureGraphIdempotencyKey(g1)).toBe(
      computeCaptureGraphIdempotencyKey(g2)
    );
  });

  it("still DIFFERS when the relation DIRECTION flips (Ada→Grace ≠ Grace→Ada)", () => {
    const g1 = {
      workspaceId: "ws-1" as string | null,
      projectId: null as string | null,
      bindings: [],
      entities: [
        { ref: "t1", profileSlug: "person", title: "Ada", properties: {} },
        { ref: "t2", profileSlug: "person", title: "Grace", properties: {} },
      ],
      relations: [{ sourceRef: "t1", targetRef: "t2", type: "knows" }],
    };
    const flipped = {
      ...g1,
      relations: [{ sourceRef: "t2", targetRef: "t1", type: "knows" }], // Grace→Ada
    };
    expect(computeCaptureGraphIdempotencyKey(g1)).not.toBe(
      computeCaptureGraphIdempotencyKey(flipped)
    );
  });
});
