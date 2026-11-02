import { describe, expect, it } from "vitest";
import type {
  PackageUpdateField,
  PackageUpdatePlan,
  PackageUpdateSummary,
} from "./contract";
import {
  applyInput,
  catalogHasYourEdit,
  choiceOptions,
  decisionOf,
  fieldMark,
  fieldShape,
  groupMark,
  groupUpdates,
  initialChoices,
  nextAfter,
  queuePosition,
  recommendedChoice,
  resultOf,
  stateCounts,
  updateFailureOf,
  updateGroupOf,
  updatesNeedingNothing,
  waitingUpdates,
} from "./updates-model";

const ZERO = { updates: 0, yours: 0, both: 0, same: 0 };
const NONE: ReadonlySet<string> = new Set();

function summary(over: Partial<PackageUpdateSummary>): PackageUpdateSummary {
  return {
    slug: "pkg",
    kind: "skill",
    name: "Package",
    installedVersion: "h-1",
    latestVersion: "h-2",
    counts: { ...ZERO },
    dataChanges: 0,
    needs: "nothing",
    reviewUrl: "/open/update/pkg",
    ...over,
  };
}

function field(over: Partial<PackageUpdateField>): PackageUpdateField {
  return {
    key: "body",
    label: "Instructions",
    state: "both",
    base: "a",
    desired: "a b",
    live: "a c",
    ...over,
  };
}

function plan(
  fields: PackageUpdateField[],
  over: Partial<PackageUpdatePlan> = {}
): PackageUpdatePlan {
  return {
    slug: "pkg",
    kind: "skill",
    name: "Package",
    installedVersion: "h-1",
    latestVersion: "h-2",
    rows: [{ rowKind: "skill", rowId: "row1", name: "Package", fields }],
    counts: { ...ZERO },
    needs: "choice",
    ...over,
  };
}

describe("updateGroupOf — the pod's needs, never re-derived", () => {
  it("groups by what the pod says the update needs", () => {
    expect(updateGroupOf(summary({ needs: "consent" }))).toBe("consent");
    expect(updateGroupOf(summary({ needs: "choice" }))).toBe("choice");
    expect(updateGroupOf(summary({ needs: "review" }))).toBe("review");
    expect(
      updateGroupOf(
        summary({ needs: "nothing", counts: { ...ZERO, yours: 2 } })
      )
    ).toBe("nothing");
  });

  it("is current when nothing is left but the same (the facecam-edit convergence)", () => {
    expect(updateGroupOf(summary({ counts: { ...ZERO, same: 7 } }))).toBe(
      "current"
    );
  });
});

describe("groupUpdates — the list's sections", () => {
  const list = [
    summary({ slug: "z", name: "Zeta", needs: "review" }),
    summary({ slug: "c", name: "Creative director", needs: "choice" }),
    summary({ slug: "f", name: "Face-camera editing", needs: "choice" }),
    summary({ slug: "v", name: "Video toolbox", counts: { ...ZERO, same: 3 } }),
    summary({ slug: "o", name: "Operations", needs: "consent" }),
    summary({ slug: "k", name: "Carousel", counts: { ...ZERO, yours: 1 } }),
  ];

  it("orders groups as the pod ranks needs and omits empty ones", () => {
    expect(groupUpdates(list).groups.map((g) => g.group)).toEqual([
      "consent",
      "choice",
      "review",
      "nothing",
    ]);
  });

  it("sorts each group by name, so a reload keeps rows in place", () => {
    expect(groupUpdates(list).groups[1]!.items.map((s) => s.slug)).toEqual([
      "c",
      "f",
    ]);
  });

  it("counts the up-to-date apart, never as a row", () => {
    const { groups, current } = groupUpdates(list);
    expect(current.map((s) => s.slug)).toEqual(["v"]);
    expect(groups.flatMap((g) => g.items).some((s) => s.slug === "v")).toBe(
      false
    );
  });

  it("waits on consent, choice and review, never on yours or current", () => {
    expect(waitingUpdates(list).map((s) => s.slug)).toEqual([
      "o",
      "c",
      "f",
      "z",
    ]);
    expect(updatesNeedingNothing(list).map((s) => s.slug)).toEqual(["z"]);
  });

  it("places the Review page in the queue, with its neighbours", () => {
    expect(queuePosition(list, "f")).toEqual({
      index: 3,
      total: 4,
      previous: "c",
      next: "z",
    });
    expect(queuePosition(list, "k")).toBeNull();
    expect(nextAfter(list, "o")).toBe("c");
    expect(nextAfter([list[1]!], "c")).toBeNull();
  });
});

describe("marks — one per state, shared by every surface", () => {
  it("gives each field state its own mark", () => {
    const tones = (["both", "updates", "yours", "same"] as const).map(
      (s) => fieldMark(s).tone
    );
    expect(new Set(tones).size).toBe(4);
    expect(fieldMark("both").tone).toBe("choose");
  });

  it("marks an update by its group, a records change apart", () => {
    expect(groupMark("choice")).toEqual(fieldMark("both"));
    expect(groupMark("consent").tone).toBe("consent");
    expect(groupMark("review")).toEqual(fieldMark("updates"));
    expect(groupMark("nothing")).toEqual(fieldMark("yours"));
  });

  it("lists only the states that have fields, what needs you first", () => {
    expect(stateCounts({ updates: 0, yours: 2, both: 1, same: 6 })).toEqual([
      { state: "both", count: 1 },
      { state: "yours", count: 2 },
      { state: "same", count: 6 },
    ]);
  });
});

describe("fieldShape — how three values are drawn", () => {
  it("draws short scalars in lanes", () => {
    expect(fieldShape(field({}))).toBe("short");
  });

  it("draws long or multi-line text as a diff", () => {
    expect(fieldShape(field({ desired: "line 1\nline 2" }))).toBe("text");
    expect(fieldShape(field({ live: "x".repeat(200) }))).toBe("text");
  });

  it("draws lists and objects as structure", () => {
    expect(fieldShape(field({ desired: ["a", "b"] }))).toBe("structured");
  });
});

describe("recommendedChoice — the pod's, never guessed", () => {
  it("shows the pod's recommendation", () => {
    expect(recommendedChoice(field({ merged: "a b" }), "catalog")).toBe(
      "catalog"
    );
    expect(recommendedChoice(field({ merged: "a b c" }), "combine")).toBe(
      "combine"
    );
  });

  it("recommends nothing when the pod did not", () => {
    expect(recommendedChoice(field({ merged: "a b c" }), undefined)).toBeNull();
  });

  it("never recommends a Combine the field cannot take", () => {
    expect(recommendedChoice(field({ merged: null }), "combine")).toBeNull();
  });

  it("recommends nothing for a field with nothing to choose", () => {
    expect(
      recommendedChoice(field({ state: "updates" }), "catalog")
    ).toBeNull();
  });

  it("says when your edit is already in the catalog's text (facecam-edit)", () => {
    expect(catalogHasYourEdit(field({ merged: "a b" }))).toBe(true);
    expect(catalogHasYourEdit(field({ merged: "a b c" }))).toBe(false);
  });
});

describe("choiceOptions — four answers, the recommended first", () => {
  it("puts the recommended one first and keeps the others in order", () => {
    const ids = choiceOptions(field({ merged: "a b c" }), "combine").map(
      (o) => o.id
    );
    expect(ids).toEqual(["combine", "catalog", "mine", "edit"]);
  });

  it("blocks Combine when it equals the catalog's, and says why", () => {
    const combine = choiceOptions(field({ merged: "a b" }), "catalog").find(
      (o) => o.id === "combine"
    );
    expect(combine?.blocked).toBe("sameAsCatalog");
  });

  it("blocks Combine on overlapping edits and on a field that is not text", () => {
    const blocked = (f: PackageUpdateField) =>
      choiceOptions(f, null).find((o) => o.id === "combine")?.blocked;
    expect(blocked(field({ merged: null, overlap: true }))).toBe("conflict");
    expect(blocked(field({ merged: undefined }))).toBe("notText");
    expect(
      choiceOptions(field({}), null)
        .filter((o) => o.blocked)
        .map((o) => o.id)
    ).toEqual(["combine"]);
  });
});

describe("the decision — what applying writes", () => {
  const both = field({ key: "body", merged: "a b c" });
  const arriving = field({
    key: "description",
    label: "Description",
    state: "updates",
    base: "d",
    desired: "d2",
    live: "d",
  });
  const mine = field({
    key: "name",
    label: "Name",
    state: "yours",
    desired: "n",
    live: "n2",
  });
  const p = plan([both, arriving, mine], {
    recommended: { "row1:body": "combine" },
  });

  it("opens on the pod's recommended choices", () => {
    expect(initialChoices(p)).toEqual({ "row1:body": "combine" });
    expect(initialChoices(plan([both]))).toEqual({});
  });

  it("counts what changes and what stays yours", () => {
    expect(decisionOf(p, { "row1:body": "combine" }, {}, NONE)).toEqual({
      changing: 2,
      keeping: 1,
      missing: [],
      primary: "update",
      blocked: null,
      recordsSkipped: 0,
    });
  });

  it("names the fields still waiting for a choice, and holds the primary", () => {
    const d = decisionOf(p, {}, {}, NONE);
    expect(d.missing).toEqual(["Instructions"]);
    expect(d.blocked).toBe("choices");
  });

  it("only records the choice when nothing would change ('Keep mine')", () => {
    const d = decisionOf(plan([both, mine]), { "row1:body": "mine" }, {}, NONE);
    expect(d.primary).toBe("keep");
    expect(d.changing).toBe(0);
    expect(d.keeping).toBe(2);
  });

  it("runs the records changes the person ticked, and says what it skips", () => {
    const records = plan([mine], {
      dataChanges: {
        count: 2,
        needsPodAdmin: true,
        items: [
          {
            id: "op-rename",
            sentence: "Renames a status",
            affected: 14,
            destructive: false,
          },
          {
            id: "op-drop",
            sentence: "Drops a field",
            affected: 3,
            destructive: true,
          },
        ],
      },
    });
    expect(decisionOf(records, {}, {}, NONE)).toMatchObject({
      primary: "keep",
      blocked: null,
      recordsSkipped: 1,
    });
    expect(decisionOf(records, {}, {}, new Set(["op-rename"]))).toMatchObject({
      primary: "update",
      recordsSkipped: 0,
    });
    // Only ticked ids go out, and never a destructive one (an operator step).
    expect(
      applyInput(records, {}, {}, new Set(["op-rename", "op-drop"]))
        .acceptDataChanges
    ).toEqual(["op-rename"]);
    expect(applyInput(records, {}, {}).acceptDataChanges).toEqual([]);
    expect("acceptDataChanges" in applyInput(p, {}, {})).toBe(false);
  });

  it("holds the primary when the pod named no catalog version", () => {
    expect(
      decisionOf(plan([arriving], { latestVersion: null }), {}, {}, NONE)
        .blocked
    ).toBe("version");
  });

  it("gives each choice its result", () => {
    expect(resultOf(both, "catalog")).toBe("a b");
    expect(resultOf(both, "mine")).toBe("a c");
    expect(resultOf(both, "combine")).toBe("a b c");
    expect(resultOf(both, "edit", "mine now")).toBe("mine now");
    expect(resultOf(both, "edit")).toBe("a b c");
    expect(resultOf(field({ merged: null }), "edit")).toBe("a b");
    expect(resultOf(arriving, undefined)).toBe("d2");
    expect(resultOf(mine, undefined)).toBe("n2");
  });

  it("sends each choice keyed <rowId>:<field>, an edit as {value}", () => {
    expect(
      applyInput(p, { "row1:body": "edit" }, { "row1:body": "x" })
    ).toEqual({
      slug: "pkg",
      expectedVersion: "h-2",
      choices: { "row1:body": { value: "x" } },
    });
    expect(applyInput(p, { "row1:body": "catalog" }, {}).choices).toEqual({
      "row1:body": "catalog",
    });
  });
});

describe("updateFailureOf — a failed read is never 'no updates'", () => {
  it("reads a moved catalog as a conflict", () => {
    expect(updateFailureOf({ data: { code: "CONFLICT" } })).toBe("conflict");
    expect(updateFailureOf({ data: { httpStatus: 409 } })).toBe("conflict");
  });

  it("reads a missing update as gone, an undo past its 30 days as expired", () => {
    expect(updateFailureOf({ data: { code: "NOT_FOUND" } })).toBe("gone");
    expect(updateFailureOf({ data: { code: "PRECONDITION_FAILED" } })).toBe(
      "expired"
    );
  });

  it("reads anything else as a failure to retry", () => {
    expect(updateFailureOf(new Error("network"))).toBe("failed");
    expect(updateFailureOf(null)).toBe("failed");
  });
});
