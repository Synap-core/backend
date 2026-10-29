/**
 * Families at one level. Each row names the rule it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  ACCESS_FAMILIES,
  GRANT_SUBJECT_CATALOG,
  GRANT_SUBJECT_GROUPS,
  KEY_POWERFUL_ACTIONS,
  accessFamiliesForScope,
  accessFamily,
  activityFamilies,
  describeKey,
  familyAccess,
  setActivityFamilies,
  setFamilyLevel,
  summarizeGrant,
  type GrantDraft,
} from "./index.js";

const records = accessFamily("records");
const content = accessFamily("content");
const activity = accessFamily("activity");
const decide = accessFamily("decide");
const none: GrantDraft = { permissions: [] };

describe("ACCESS_FAMILIES", () => {
  it("are Records, Content, Work, Activity, Decide, in that order", () => {
    expect(ACCESS_FAMILIES.map((f) => f.label)).toEqual([
      "Records",
      "Content",
      "Work",
      "Activity",
      "Decide",
    ]);
  });

  // Rules out: a hand list that falls behind the catalog. Every subject a key
  // can be given sits in exactly one leveled family.
  it("cover every catalog subject once, derived from the sections", () => {
    const leveled = ACCESS_FAMILIES.filter((f) => f.id !== "decide");
    const all = leveled.flatMap((f) => f.subjects);
    expect([...all].sort()).toEqual(
      GRANT_SUBJECT_CATALOG.map((s) => s.subject).sort()
    );
    for (const f of leveled)
      expect(f.label).toBe(
        GRANT_SUBJECT_GROUPS.find((g) => g.id === f.id)!.label
      );
  });

  it("offer no Activity at project scope (answer 26)", () => {
    expect(accessFamiliesForScope("project").map((f) => f.id)).not.toContain(
      "activity"
    );
    expect(accessFamiliesForScope("space").map((f) => f.id)).toContain(
      "activity"
    );
  });
});

describe("familyAccess", () => {
  // Rules out: the Dev loop poster (event.create only) reading as Off or as
  // "only some" because it does not also read.
  it("the Dev loop poster is Activity · Post, whole", () => {
    expect(familyAccess({ permissions: ["event.create"] }, activity)).toEqual({
      level: "post",
      partial: false,
    });
    expect(familyAccess({ permissions: ["event.create"] }, records)).toEqual({
      level: "off",
      partial: false,
    });
  });

  it("a family limited to one activity family is Post, only some", () => {
    expect(
      familyAccess({ permissions: ["event.ci.create"] }, activity)
    ).toEqual({ level: "post", partial: true });
  });

  // Rules out: a level that ignores kinds (one kind's write is Edit, partial).
  it("one kind's write is Records · Edit, only some; every read is View", () => {
    expect(
      familyAccess({ permissions: ["entity.note.create"] }, records)
    ).toEqual({ level: "edit", partial: true });
    expect(familyAccess({ permissions: ["entity.*.read"] }, records)).toEqual({
      level: "view",
      partial: false,
    });
  });

  it("full access is every family at its top level, never partial", () => {
    const full = { permissions: ["*"] };
    expect(ACCESS_FAMILIES.map((f) => familyAccess(full, f).level)).toEqual([
      "edit",
      "edit",
      "edit",
      "post",
      "on",
    ]);
  });

  it("Decide is On only for a gate verb, partial unless all four", () => {
    expect(
      familyAccess({ permissions: ["entity.*.delete"] }, decide).level
    ).toBe("off");
    expect(familyAccess({ permissions: ["proposal.approve"] }, decide)).toEqual(
      { level: "on", partial: true }
    );
    expect(
      familyAccess(
        { permissions: KEY_POWERFUL_ACTIONS.map((a) => a.pattern) },
        decide
      )
    ).toEqual({ level: "on", partial: false });
  });
});

describe("setFamilyLevel", () => {
  // Rules out: Edit stopping short of delete (answer 24) — and the mark
  // that must then say so.
  it("Edit gives every catalog action, delete included, and marks it", () => {
    const d = setFamilyLevel(none, records, "edit");
    expect(d.permissions).toEqual([
      "entity.*.read",
      "entity.*.create",
      "entity.*.update",
      "entity.*.delete",
    ]);
    const marks = describeKey({ name: "k", uses: ["hub"], grant: d }).marks;
    expect(marks.map((m) => m.code)).toEqual(["can-delete"]);
  });

  it("View gives reads only; Off removes the family and nothing else", () => {
    const both = setFamilyLevel(
      setFamilyLevel(none, records, "edit"),
      content,
      "view"
    );
    expect(both.permissions).toContain("document.read");
    expect(both.permissions).not.toContain("document.update");
    const off = setFamilyLevel(both, records, "off");
    expect(off.permissions).toEqual([
      "document.read",
      "view.read",
      "relation.read",
    ]);
  });

  // Rules out: Off leaving a kind-specific pattern behind.
  it("Off removes kind patterns too, and keeps a gate verb (Decide's)", () => {
    const off = setFamilyLevel(
      { permissions: ["entity.note.create", "entity.note.merge"] },
      records,
      "off"
    );
    expect(off.permissions).toEqual(["entity.note.merge"]);
  });

  // Rules out: narrowing full access WIDENING into a list that still holds `*`.
  it("from full access, one family Off keeps the others at their top level", () => {
    const d = setFamilyLevel({ permissions: ["*"] }, activity, "off");
    expect(d.permissions).not.toContain("*");
    expect(familyAccess(d, activity).level).toBe("off");
    expect(familyAccess(d, records)).toEqual({ level: "edit", partial: false });
    expect(familyAccess(d, decide)).toEqual({ level: "on", partial: false });
  });

  it("Post is event.create; the summary says Create Activity", () => {
    const d = setFamilyLevel(none, activity, "post");
    expect(d.permissions).toEqual(["event.create"]);
    expect(summarizeGrant(d).what).toBe("Create Activity");
  });
});

describe("activity families", () => {
  it("limit posting to dev and CI, then back to every family", () => {
    const dev = setActivityFamilies({ permissions: ["event.create"] }, ["dev"]);
    expect(dev.permissions).toEqual(["event.dev.create"]);
    expect(activityFamilies(dev)).toEqual(["dev"]);
    expect(setActivityFamilies(dev, null).permissions).toEqual([
      "event.create",
    ]);
  });

  // Rules out: limiting posting also dropping the read a bare `event` holds.
  it("a bare event keeps its read when posting is limited", () => {
    expect(
      setActivityFamilies({ permissions: ["event"] }, ["ci"]).permissions
    ).toEqual(["event.read", "event.ci.create"]);
  });
});
