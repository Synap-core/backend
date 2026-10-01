/**
 * Pin-list decisions. Pure — no database. The discriminating case for the
 * walk is "the first eligible id, not the last": a rule that returns the
 * tail agrees with a one-id list and hides the bug.
 */
import { describe, expect, it } from "vitest";
import { definitionVersionChanged } from "./definition-version.js";
import {
  PIN_LIST_CAP,
  decidePinnedSubject,
  explainPinnedIdRejection,
  fillSoleRequiredEntityParam,
  metadataAfterUnpin,
  parsePinnedEntityIds,
  pickFirstEligible,
  readPinnedIds,
  shouldDropPin,
} from "./pinned-subject.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const CONTENT_PARAMS = [
  { name: "post", type: "entity", required: true },
  { name: "platform", type: "text", required: true },
  { name: "format", type: "text", required: false },
];

describe("pickFirstEligible", () => {
  it("returns the first eligible id, skipping ones that are not ready", () => {
    expect(pickFirstEligible([A, B, C], (id) => id === B || id === C)).toBe(B);
  });

  it("returns null when nobody is eligible", () => {
    expect(pickFirstEligible([A, B], () => false)).toBeNull();
    expect(pickFirstEligible([], () => true)).toBeNull();
  });
});

describe("decidePinnedSubject", () => {
  it("a caller subject wins and does not need to be on the list", () => {
    const decision = decidePinnedSubject({
      callerSubjectId: C,
      pinnedIds: [A],
      eligibleIds: new Set([A]),
      fallbackId: B,
    });
    expect(decision).toEqual({ outcome: "caller", subjectId: C });
  });

  it("uses the first eligible pin", () => {
    const decision = decidePinnedSubject({
      callerSubjectId: null,
      pinnedIds: [A, B],
      eligibleIds: new Set([B]),
      fallbackId: C,
    });
    expect(decision).toEqual({ outcome: "pin", subjectId: B });
  });

  it("falls back only when no pin is eligible, without inserting that id", () => {
    const pinnedIds = [A];
    const decision = decidePinnedSubject({
      callerSubjectId: "  ",
      pinnedIds,
      eligibleIds: new Set(),
      fallbackId: B,
    });
    expect(decision).toEqual({ outcome: "fallback", subjectId: B });
    expect(pinnedIds).toEqual([A]);
  });

  it("skips when the list and the fallback are both empty", () => {
    expect(
      decidePinnedSubject({
        pinnedIds: [],
        eligibleIds: new Set(),
        fallbackId: null,
      })
    ).toEqual({ outcome: "skip" });
  });
});

describe("parsePinnedEntityIds", () => {
  it("keeps order and accepts an empty list", () => {
    expect(parsePinnedEntityIds([B, A])).toEqual({ ok: true, ids: [B, A] });
    expect(parsePinnedEntityIds([])).toEqual({ ok: true, ids: [] });
  });

  it("refuses a duplicate, a non-id, and a list over the cap", () => {
    expect(parsePinnedEntityIds([A, A]).ok).toBe(false);
    expect(parsePinnedEntityIds([A, "post"]).ok).toBe(false);
    expect(parsePinnedEntityIds("nope").ok).toBe(false);
    // Unique ids, so a missing cap check would accept the list. A duplicate
    // of A would fail for the wrong reason and hide that.
    const over = Array.from({ length: PIN_LIST_CAP + 1 }, (_, i) => {
      const tail = (i + 1).toString(16).padStart(12, "0");
      return `11111111-1111-4111-8111-${tail}`;
    });
    expect(parsePinnedEntityIds(over).ok).toBe(false);
  });
});

describe("readPinnedIds", () => {
  it("drops junk at read time and keeps the first of a duplicate", () => {
    expect(
      readPinnedIds({
        pinnedEntityIds: [A, "nope", A, B],
        marketSource: { packageSlug: "content-os" },
      })
    ).toEqual([A, B]);
  });
});

describe("explainPinnedIdRejection", () => {
  it("names a visible record of the wrong kind and hides one that is not visible", () => {
    expect(
      explainPinnedIdRejection([A], [{ id: A, type: "task" }], "post")
    ).toMatch(/Post/);
    expect(
      explainPinnedIdRejection([A], [{ id: A, type: "task" }], "post")
    ).toMatch(/Task/);
    expect(explainPinnedIdRejection([B], [], "post")).toBe(
      "That record is not available to pin."
    );
    expect(
      explainPinnedIdRejection([A], [{ id: A, type: "post" }], "post")
    ).toBeNull();
  });
});

describe("fillSoleRequiredEntityParam", () => {
  it("fills the one empty required entity param and leaves platform alone", () => {
    expect(
      fillSoleRequiredEntityParam({ platform: "" }, CONTENT_PARAMS, A)
    ).toEqual({ platform: "", post: A });
  });

  it("does not overwrite a post that was already set", () => {
    expect(
      fillSoleRequiredEntityParam({ post: B, platform: "x" }, CONTENT_PARAMS, A)
    ).toEqual({ post: B, platform: "x" });
  });

  it("does not guess when two entity params are required", () => {
    const params = { platform: "" };
    const declared = [
      ...CONTENT_PARAMS,
      { name: "source", type: "entity", required: true },
    ];
    expect(fillSoleRequiredEntityParam(params, declared, A)).toBe(params);
  });
});

describe("metadataAfterUnpin", () => {
  it("removes only the closed subject and keeps the rest of the bag", () => {
    const next = metadataAfterUnpin(
      { pinnedEntityIds: [A, B], marketSource: { packageSlug: "content-os" } },
      A
    );
    expect(next).toEqual({
      pinnedEntityIds: [B],
      marketSource: { packageSlug: "content-os" },
    });
  });

  it("does not write when the id is not on the list", () => {
    expect(metadataAfterUnpin({ pinnedEntityIds: [B] }, A)).toBeNull();
  });
});

describe("shouldDropPin", () => {
  it("drops on a successful close only", () => {
    expect(shouldDropPin("closed")).toBe(true);
    expect(shouldDropPin("cancelled")).toBe(false);
    expect(shouldDropPin("failed")).toBe(false);
  });
});

describe("definition version", () => {
  it("a pin-list edit does not bump the version", () => {
    expect(
      definitionVersionChanged(
        { metadata: { pinnedEntityIds: [A] } },
        { metadata: {}, inputStrategy: { kind: "pinned" } }
      )
    ).toBe(false);
  });

  it("an input-strategy edit does bump the version", () => {
    expect(
      definitionVersionChanged(
        { inputStrategy: { kind: "pinned" } },
        { inputStrategy: { kind: "none" } }
      )
    ).toBe(true);
    expect(
      definitionVersionChanged(
        { inputStrategy: { kind: "none" } },
        { inputStrategy: { kind: "none" } }
      )
    ).toBe(false);
  });
});
