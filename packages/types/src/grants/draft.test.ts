/**
 * The grant selector model. Each row names the WRONG rule it rules out — a
 * table of representative rows would pass a toggle that drops the whole
 * covering pattern, a compaction that fires at three of four actions, or a
 * normaliser that promotes to `*`.
 */
import { describe, expect, it } from "vitest";
import { resolveObjectNounPlural } from "../vocabulary/index.js";
import {
  applyGrantRole,
  EMPTY_GRANT_DRAFT,
  GRANT_PRESETS,
  GRANT_SUBJECT_CATALOG,
  isGranted,
  isImpliedByAllKinds,
  matchGrantRole,
  normalizeGrantPermissions,
  parsePermission,
  patternMatches,
  setGrantLifetime,
  setGrantPermissions,
  setGrantWorkspaces,
  setRowActions,
  summarizeGrant,
  toggleGrant,
  toGrantMintInput,
  validateGrantDraft,
  type GrantCell,
  type GrantDraft,
} from "./index.js";

const ctx = { kinds: ["note", "task", "person"] };
const draft = (...permissions: string[]): GrantDraft => ({ permissions });

/** Every checkbox the catalog offers, for the kinds in ctx (+ every kind). */
const ALL_CELLS: GrantCell[] = GRANT_SUBJECT_CATALOG.flatMap((spec) =>
  (spec.subject === "entity" ? ["*", ...ctx.kinds] : [null]).flatMap((kind) =>
    spec.actions.map((action) => ({ subject: spec.subject, kind, action }))
  )
);

describe("catalog ⊂ grammar", () => {
  it("offers a non-trivial set of cells (non-vacuity)", () => {
    expect(ALL_CELLS.length).toBeGreaterThan(30);
  });
  it("every cell is a valid key that matches itself", () => {
    for (const c of ALL_CELLS) {
      const key =
        c.subject === "entity"
          ? `entity.${c.kind}.${c.action}`
          : `${c.subject}.${c.action}`;
      expect(() => parsePermission(key)).not.toThrow();
      expect(isGranted(draft(key), c)).toBe(true);
    }
  });
});

describe("toggleGrant ON", () => {
  it("adds the one cell", () => {
    const d = toggleGrant(
      EMPTY_GRANT_DRAFT,
      { subject: "entity", kind: "note", action: "read" },
      true,
      ctx
    );
    expect(d.permissions).toEqual(["entity.note.read"]);
  });
  it("compacts all four actions on a kind to the kind pattern (entity.knowledge)", () => {
    const d = setRowActions(
      EMPTY_GRANT_DRAFT,
      { subject: "entity", kind: "knowledge" },
      ["read", "create", "update", "delete"],
      ctx
    );
    expect(d.permissions).toEqual(["entity.knowledge"]);
  });
  it("does NOT compact three of four (rules out a >=3 threshold)", () => {
    const d = setRowActions(
      EMPTY_GRANT_DRAFT,
      { subject: "document" },
      ["read", "create", "update"],
      ctx
    );
    expect(d.permissions).toEqual([
      "document.read",
      "document.create",
      "document.update",
    ]);
  });
  it("never promotes to * — even with every catalog cell on", () => {
    let d: GrantDraft = EMPTY_GRANT_DRAFT;
    for (const c of ALL_CELLS) d = toggleGrant(d, c, true, ctx);
    expect(d.permissions).not.toContain("*");
    expect(d.permissions).toContain("entity");
    expect(ALL_CELLS.every((c) => isGranted(d, c))).toBe(true);
  });
});

describe("toggleGrant OFF", () => {
  it("splits an every-kind grant into the other kinds (rules out dropping the whole pattern)", () => {
    const d = toggleGrant(
      draft("entity.*.read"),
      { subject: "entity", kind: "note", action: "read" },
      false,
      ctx
    );
    expect(d.permissions).toEqual(["entity.person.read", "entity.task.read"]);
    expect(
      isGranted(d, { subject: "entity", kind: "note", action: "read" })
    ).toBe(false);
    expect(
      isGranted(d, { subject: "entity", kind: "task", action: "read" })
    ).toBe(true);
    expect(
      isGranted(d, { subject: "entity", kind: "person", action: "read" })
    ).toBe(true);
    expect(d.permissions).not.toContain("entity.*.read");
  });
  it("removes exactly one action from a subject pattern", () => {
    const d = toggleGrant(
      draft("document"),
      { subject: "document", action: "read" },
      false,
      ctx
    );
    expect(d.permissions).toEqual([
      "document.create",
      "document.update",
      "document.delete",
    ]);
  });
  it("unticking every-kind removes it for every kind", () => {
    const d = toggleGrant(
      draft("entity.*.read", "document.read"),
      { subject: "entity", action: "read" },
      false,
      ctx
    );
    expect(d.permissions).toEqual(["document.read"]);
  });
  it("breaking * narrows to the catalog and never keeps *", () => {
    const d = toggleGrant(
      draft("*"),
      { subject: "entity", kind: "note", action: "delete" },
      false,
      ctx
    );
    expect(d.permissions).not.toContain("*");
    expect(
      isGranted(d, { subject: "entity", kind: "note", action: "delete" })
    ).toBe(false);
    expect(
      isGranted(d, { subject: "entity", kind: "task", action: "delete" })
    ).toBe(true);
    expect(isGranted(d, { subject: "document", action: "read" })).toBe(true);
    // Documented narrowing: subjects outside the catalog are dropped.
    expect(
      d.permissions.some((p) =>
        patternMatches(p, { subject: "vault", action: "redeem" })
      )
    ).toBe(false);
  });
  it("leaves unrelated and outside-catalog patterns verbatim", () => {
    const d = toggleGrant(
      draft("vault.redeem", "document.read", "view.read"),
      { subject: "view", action: "read" },
      false,
      ctx
    );
    expect(d.permissions).toEqual(["document.read", "vault.redeem"]);
  });
});

describe("isGranted / implied", () => {
  it("a kind grant never covers the every-kind cell (unknown-kind rule)", () => {
    expect(
      isGranted(draft("entity.note.read"), {
        subject: "entity",
        action: "read",
      })
    ).toBe(false);
    expect(
      isGranted(draft("entity.*.read"), {
        subject: "entity",
        kind: "note",
        action: "read",
      })
    ).toBe(true);
  });
  it("marks a kind cell implied only when every-kind holds it", () => {
    const c: GrantCell = { subject: "entity", kind: "note", action: "read" };
    expect(isImpliedByAllKinds(draft("entity.*.read"), c)).toBe(true);
    expect(isImpliedByAllKinds(draft("entity.note.read"), c)).toBe(false);
  });
});

describe("normalizeGrantPermissions", () => {
  it("normalises the governance spelling and dedupes", () => {
    expect(normalizeGrantPermissions(["entity.read", "entity.*.read"])).toEqual(
      ["entity.*.read"]
    );
  });
  it("drops a pattern a broader one covers", () => {
    expect(normalizeGrantPermissions(["entity.note.read", "entity"])).toEqual([
      "entity",
    ]);
  });
  it("keeps invalid patterns visible at the end", () => {
    expect(normalizeGrantPermissions(["Bad", "view.read"])).toEqual([
      "view.read",
      "Bad",
    ]);
  });
  it("never changes any catalog cell's coverage", () => {
    const samples = [
      [
        "entity.*.read",
        "entity.note.create",
        "entity.note.update",
        "entity.note.delete",
      ],
      [
        "document.read",
        "document.create",
        "document.update",
        "document.delete",
        "view.read",
      ],
      ["entity.task", "entity.*.read", "proposal.read", "channel.create"],
    ];
    for (const s of samples) {
      const n = normalizeGrantPermissions(s);
      for (const c of ALL_CELLS)
        expect([c, isGranted(draft(...n), c)]).toEqual([
          c,
          isGranted(draft(...s), c),
        ]);
    }
  });
});

describe("validateGrantDraft", () => {
  it("accepts a good draft, never-expiring included", () => {
    expect(
      validateGrantDraft({ permissions: ["view.read"], expiresInDays: null })
    ).toEqual({ ok: true });
  });
  it("lists every problem, not only the first", () => {
    const v = validateGrantDraft({
      permissions: ["Bad", "x.y.z"],
      expiresInDays: 0,
    });
    expect(v.ok).toBe(false);
    if (!v.ok)
      expect(v.problems.map((p) => p.code)).toEqual([
        "invalid-permission",
        "invalid-permission",
        "invalid-lifetime",
      ]);
  });
  it("refuses an empty grant and an over-long lifetime", () => {
    const v = validateGrantDraft({ permissions: [], expiresInDays: 36_501 });
    expect(v.ok).toBe(false);
    if (!v.ok)
      expect(v.problems.map((p) => p.code)).toEqual([
        "no-permissions",
        "invalid-lifetime",
      ]);
  });
});

describe("toGrantMintInput", () => {
  it("omits absent narrowing and an absent lifetime (the door takes no null sets)", () => {
    expect(
      toGrantMintInput({
        permissions: ["entity.read"],
        workspaceIds: null,
        projectIds: [],
      })
    ).toEqual({
      grant: { permissions: ["entity.*.read"] },
    });
  });
  it("keeps an explicit never (null) and the narrowing", () => {
    const d = setGrantLifetime(
      setGrantWorkspaces(draft("view.read"), ["w1"]),
      null
    );
    expect(toGrantMintInput(d)).toEqual({
      grant: { permissions: ["view.read"], workspaceIds: ["w1"] },
      expiresInDays: null,
    });
  });
});

describe("summarizeGrant", () => {
  it("one line for a read-only site, words from the vocabulary", () => {
    const s = summarizeGrant(GRANT_PRESETS[0].grant);
    expect(s.sentence).toBe(
      `Read ${resolveObjectNounPlural("entity")}, ${resolveObjectNounPlural("document")}, ${resolveObjectNounPlural("view")} · 90 days`
    );
    expect(s.rows.map((r) => r.key)).toEqual(["entity", "document", "view"]);
    expect([s.where, s.when]).toEqual([[], "90 days"]);
    const narrowed = summarizeGrant({
      ...GRANT_PRESETS[0].grant,
      workspaceIds: ["w1", "w2"],
    });
    expect(narrowed.where).toEqual([
      `2 ${resolveObjectNounPlural("workspace")}`,
    ]);
  });
  it("full access and never-expiring are marked, not buried", () => {
    const s = summarizeGrant({ permissions: ["*"], expiresInDays: null });
    expect(s.full).toBe(true);
    expect(s.lifetime).toEqual({ kind: "never" });
    expect(s.sentence).toBe("Full access · Never expires");
  });
  it("a kind row lists only what every-kind does not, with the pod's name", () => {
    const s = summarizeGrant(draft("entity.*.read", "entity.note"), {
      kindNames: { note: "Notes (mine)" },
    });
    expect(s.rows).toEqual([
      {
        key: "entity",
        subject: "entity",
        kind: "*",
        label: resolveObjectNounPlural("entity"),
        actions: ["read"],
        all: false,
      },
      {
        key: "entity.note",
        subject: "entity",
        kind: "note",
        label: "Notes (mine)",
        actions: ["create", "update", "delete"],
        all: true,
      },
    ]);
  });
  it("lists outside-catalog and invalid patterns instead of dropping them", () => {
    const s = summarizeGrant(draft("vault.redeem", "entity.note.merge", "Bad"));
    expect(s.other).toEqual(["entity.note.merge", "vault.redeem"]);
    expect(s.invalid).toEqual(["Bad"]);
  });
});

describe("presets (roles)", () => {
  it("are valid grants", () => {
    for (const r of GRANT_PRESETS)
      expect(validateGrantDraft(r.grant)).toEqual({ ok: true });
  });
  it("are recognised by value, whatever the spelling or order", () => {
    expect(
      matchGrantRole(draft("view.read", "document.read", "entity.read"))?.id
    ).toBe("read-only-site");
    expect(matchGrantRole(draft("view.read"))).toBeUndefined();
  });
  it("applying one keeps the draft's narrowing and lifetime", () => {
    const d = applyGrantRole(
      { permissions: ["*"], workspaceIds: ["w1"], expiresInDays: 7 },
      GRANT_PRESETS[0]
    );
    expect(d).toEqual({
      permissions: ["entity.*.read", "document.read", "view.read"],
      workspaceIds: ["w1"],
      expiresInDays: 7,
    });
  });
  it("setGrantPermissions normalises", () => {
    expect(
      setGrantPermissions(EMPTY_GRANT_DRAFT, ["entity.read"]).permissions
    ).toEqual(["entity.*.read"]);
  });
});
