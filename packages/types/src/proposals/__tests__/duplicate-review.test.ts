/**
 * "Looks like X" on every review card (FB1020 B2), driven from the WIRE shape
 * the pod stores: `proposals.data` with `duplicateCheck` at its top, beside
 * the request envelope. Moved down with the rule from synap-app's
 * `@synap-core/hooks/proposal-types/duplicateCheck.test.ts`.
 *
 * Rows that rule out a wrong rule:
 *  - only RECORD twins of a single entity create are resolvable with the
 *    approve verbs; a pending-proposal twin is a door only;
 *  - a graph's twins are resolved per ITEM (keyed by the op ref), never at
 *    card level;
 *  - `clear` draws nothing, and a FAILED lookup is said, never read as no twin.
 */
import { describe, expect, it } from "vitest";
import {
  DUPLICATE_RESOLUTION_VERBS,
  PRIMARY_DUPLICATE_VERB,
  deriveDuplicateReview,
  duplicateCandidateLabel,
  duplicateObjectKind,
  duplicateResolutionFor,
  duplicateWhyLabel,
  identityResolutionByRefFor,
  needsIdentityChoice,
  ownCreateDuplicateWarning,
  type DuplicateItemReview,
} from "../duplicate-review.js";
import type { DuplicateCandidate } from "../duplicate-check.js";

const RECORD: DuplicateCandidate = {
  ref: "record",
  id: "ent-ada",
  kind: "person",
  title: "Ada Lovelace",
  why: "same_name",
};
const PENDING: DuplicateCandidate = {
  ref: "proposal",
  id: "prop-ada",
  kind: "person",
  title: "Ada Lovelace",
  why: "same_name",
};

const stored = (duplicateCheck: unknown) => ({
  requestId: "r-1",
  changeType: "create",
  data: { id: "minted", profileSlug: "person", title: "Ada Lovelace" },
  duplicateCheck,
});

const single = (duplicateCheck: unknown) =>
  deriveDuplicateReview(stored(duplicateCheck), { singleEntityCreate: true });

describe("deriveDuplicateReview — the duplicate door's answer, as a card reads it", () => {
  it("an entity create's record twin is shown AND resolvable with the approve verbs", () => {
    const d = single({
      status: "possible",
      subject: "entity",
      candidates: [RECORD, PENDING],
    });
    expect(d?.candidates.map((c) => c.id)).toEqual(["ent-ada", "prop-ada"]);
    expect(d?.resolvable.map((c) => c.id)).toEqual(["ent-ada"]);
    expect(needsIdentityChoice({ duplicate: d })).toBe(true);
  });

  it("a graph's twins are resolved per item, keyed by the op ref", () => {
    const d = deriveDuplicateReview(
      {
        operations: [{ op: "create_entity", ref: "e0", title: "Ada Lovelace" }],
        duplicateCheck: {
          status: "possible",
          subject: "entity",
          candidates: [{ ...RECORD, forRef: "e0", forTitle: "Ada Lovelace" }],
        },
      },
      { singleEntityCreate: false }
    );
    expect(d?.resolvable).toEqual([]);
    expect(
      d?.items.map((i) => [i.forRef, i.resolvable.map((c) => c.id)])
    ).toEqual([["e0", ["ent-ada"]]]);
    expect(needsIdentityChoice({ duplicate: d })).toBe(true);
  });

  it("clear draws nothing; a FAILED lookup is said, never read as no twin", () => {
    expect(
      single({ status: "clear", subject: "entity", candidates: [] })
    ).toBeNull();
    expect(single(undefined)).toBeNull();
    const unchecked = single({
      status: "unchecked",
      subject: "entity",
      candidates: [],
    });
    expect(unchecked?.check.status).toBe("unchecked");
    expect(needsIdentityChoice({ duplicate: unchecked })).toBe(false);
  });

  it("a waiting twin alone, or a playbook twin, is a door — never a verb choice", () => {
    expect(
      needsIdentityChoice({
        duplicate: single({
          status: "possible",
          subject: "entity",
          candidates: [PENDING],
        }),
      })
    ).toBe(false);
    expect(
      needsIdentityChoice({
        duplicate: single({
          status: "possible",
          subject: "playbook",
          candidates: [{ ...RECORD, kind: "playbook" }],
        }),
      })
    ).toBe(false);
    expect(needsIdentityChoice(null)).toBe(false);
  });
});

describe("the verbs — the pod's four, in the product's order", () => {
  it("fill empty first (the one primary), keep both last", () => {
    expect(DUPLICATE_RESOLUTION_VERBS.map((v) => [v.verb, v.label])).toEqual([
      ["fill_empty", "Fill empty fields"],
      ["keep_existing", "Use existing"],
      ["use_capture", "Overwrite with these"],
      ["separate", "Keep both"],
    ]);
    expect(PRIMARY_DUPLICATE_VERB).toBe(DUPLICATE_RESOLUTION_VERBS[0]!.verb);
  });

  it("keep both never needs a record; the other verbs bind to the one record", () => {
    expect(duplicateResolutionFor("separate", [], null)).toEqual({
      verb: "separate",
    });
    expect(duplicateResolutionFor("fill_empty", [{ id: "a" }], null)).toEqual({
      verb: "fill_empty",
      existingEntityId: "a",
    });
  });

  it("several records need an explicit pick that is one of them", () => {
    const two = [{ id: "a" }, { id: "b" }];
    expect(duplicateResolutionFor("keep_existing", two, null)).toBeNull();
    expect(duplicateResolutionFor("keep_existing", two, "z")).toBeNull();
    expect(duplicateResolutionFor("keep_existing", two, "b")).toEqual({
      verb: "keep_existing",
      existingEntityId: "b",
    });
  });
});

describe("identityResolutionByRefFor — a graph approve's per-item map", () => {
  const one: DuplicateItemReview = {
    forRef: "e0",
    forTitle: "Ada",
    resolvable: [RECORD],
  };
  const two: DuplicateItemReview = {
    forRef: "e1",
    forTitle: "Acme",
    resolvable: [
      { ...RECORD, id: "c-1" },
      { ...RECORD, id: "c-2" },
    ],
  };

  it("one twin defaults to Fill empty fields bound to it", () => {
    expect(identityResolutionByRefFor([one], {})).toEqual({
      byRef: { e0: { verb: "fill_empty", existingEntityId: "ent-ada" } },
      missing: [],
    });
  });

  it("several twins wait for a pick; keep both never does", () => {
    const waiting = identityResolutionByRefFor([one, two], {});
    expect(Object.keys(waiting.byRef)).toEqual(["e0"]);
    expect(waiting.missing.map((i) => i.forRef)).toEqual(["e1"]);
    expect(
      identityResolutionByRefFor([two], {
        e1: { verb: "keep_existing", pickedId: "c-2" },
      }).byRef
    ).toEqual({ e1: { verb: "keep_existing", existingEntityId: "c-2" } });
    expect(
      identityResolutionByRefFor([two], {
        e1: { verb: "separate", pickedId: null },
      }).byRef
    ).toEqual({ e1: { verb: "separate" } });
  });
});

describe("candidate words and doors (one rule for every card)", () => {
  it("a record opens itself, a waiting twin opens its review", () => {
    expect(duplicateObjectKind(RECORD)).toBe("entity");
    expect(duplicateObjectKind({ ...RECORD, kind: "playbook" })).toBe(
      "playbook"
    );
    expect(duplicateObjectKind(PENDING)).toBe("proposal");
  });

  it("labels name the item a graph twin is for, and why it matched", () => {
    expect(duplicateCandidateLabel({ ...RECORD, forTitle: "Ada L." })).toBe(
      "Ada Lovelace (for Ada L.)"
    );
    expect(duplicateCandidateLabel({ ...RECORD, title: "  " })).toBe(
      "Untitled"
    );
    expect(duplicateWhyLabel({ why: "similar_name" })).toBe("Similar name");
    // A demo twin is marked (founder default 1): never a silent merge target.
    expect(
      duplicateWhyLabel({ why: "same_identity", sample: true } as never)
    ).toBe("Same identity · Sample");
  });
});

describe("ownCreateDuplicateWarning — a person's create is warned, never blocked (B2e)", () => {
  it("names the existing record off the create receipt, counts the rest", () => {
    expect(
      ownCreateDuplicateWarning({
        duplicateCheck: {
          status: "possible",
          subject: "entity",
          candidates: [RECORD],
        },
      })
    ).toBe("It looks like Ada Lovelace, which you already have.");
    expect(
      ownCreateDuplicateWarning({
        duplicateCheck: {
          status: "possible",
          subject: "entity",
          candidates: [RECORD, { ...RECORD, id: "ent-2" }],
        },
      })
    ).toBe("It looks like Ada Lovelace and 1 more you already have.");
  });

  it("says nothing for clear, a failed lookup or no answer", () => {
    for (const status of ["clear", "unchecked"]) {
      expect(
        ownCreateDuplicateWarning({
          duplicateCheck: { status, subject: "entity", candidates: [] },
        })
      ).toBeNull();
    }
    expect(ownCreateDuplicateWarning({ id: "new" })).toBeNull();
  });
});
