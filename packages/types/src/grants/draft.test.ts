/**
 * The grant selector model. Each row names the WRONG rule it rules out — a
 * table of representative rows would pass a toggle that drops the whole
 * covering pattern, a normaliser that widens ticked actions into a subject
 * pattern (which grants actions the catalog never shows), or one that
 * promotes to `*`.
 */
import { describe, expect, it } from "vitest";
import { resolveObjectNounPlural } from "../vocabulary/index.js";
import {
  applyGrantRole,
  EMPTY_GRANT_DRAFT,
  GRANT_FULL_ACCESS_SENTENCE,
  GRANT_PRESETS,
  GRANT_SUBJECT_CATALOG,
  grantMintFromRole,
  isGranted,
  isImpliedByAllKinds,
  matchGrantRole,
  MAX_GRANT_PERMISSIONS,
  normalizeGrantPermissions,
  parsePermission,
  patternMatches,
  setGrantLifetime,
  setGrantPermissions,
  setGrantWorkspaces,
  summarizeGrant,
  toggleGrant,
  toGrantMintInput,
  toGrantRoleInput,
  validateGrantDraft,
  type GrantCell,
  type GrantDraft,
  type GrantRole,
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

/** Tick each action of one row, one toggle at a time — as a person does. */
const tickAll = (
  row: { subject: string; kind?: string },
  actions: GrantCell["action"][]
): GrantDraft =>
  actions.reduce<GrantDraft>(
    (d, action) => toggleGrant(d, { ...row, action }, true, ctx),
    EMPTY_GRANT_DRAFT
  );

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
  it("never rewrites four ticked actions into the kind pattern", () => {
    const d = tickAll({ subject: "entity", kind: "knowledge" }, [
      "read",
      "create",
      "update",
      "delete",
    ]);
    expect(d.permissions).toEqual([
      "entity.knowledge.read",
      "entity.knowledge.create",
      "entity.knowledge.update",
      "entity.knowledge.delete",
    ]);
  });
  it("reading proposals stays proposal.read — never `proposal` (which also creates, updates and deletes)", () => {
    const d = toggleGrant(
      EMPTY_GRANT_DRAFT,
      { subject: "proposal", action: "read" },
      true,
      ctx
    );
    expect(d.permissions).toEqual(["proposal.read"]);
  });
  it("does NOT compact three of four (rules out a >=3 threshold)", () => {
    const d = tickAll({ subject: "document" }, ["read", "create", "update"]);
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
    expect(d.permissions).not.toContain("entity");
    expect(d.permissions).not.toContain("proposal");
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
  // Rules out: dropping a named gate verb under a bare pattern that no longer
  // covers it — the person's `merge` would vanish on save.
  it("keeps a named gate verb beside a bare pattern; only * or the verb covers it", () => {
    expect(
      normalizeGrantPermissions([
        "proposal",
        "entity.note.merge",
        "proposal.approve",
        "entity",
      ])
    ).toEqual(["entity", "entity.note.merge", "proposal", "proposal.approve"]);
    expect(
      normalizeGrantPermissions(["entity.*.merge", "entity.note.merge"])
    ).toEqual(["entity.*.merge"]);
    expect(normalizeGrantPermissions(["*", "proposal.approve"])).toEqual(["*"]);
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

describe("validateGrantDraft — the mint door's cap", () => {
  // Unticking one kind under "Every kind" splits the pattern into one per
  // remaining kind: 40 kinds × 4 actions lands at 156 patterns, which the door
  // (permissions.max(MAX_GRANT_PERMISSIONS)) refuses. The editor must say so before Save.
  it("reports a draft past MAX_GRANT_PERMISSIONS, in words", () => {
    const kinds = Array.from({ length: 40 }, (_, i) => `kind${i}`);
    let d = draft(
      "entity.*.read",
      "entity.*.create",
      "entity.*.update",
      "entity.*.delete"
    );
    for (const action of ["read", "create", "update", "delete"] as const)
      d = toggleGrant(d, { subject: "entity", kind: "kind0", action }, false, {
        kinds,
      });
    expect(d.permissions).toHaveLength(156);
    const v = validateGrantDraft(d);
    expect(v.ok).toBe(false);
    const p =
      !v.ok && v.problems.find((x) => x.code === "too-many-permissions");
    expect(p).toMatchObject({ count: 156, max: MAX_GRANT_PERMISSIONS });
    expect(p && "message" in p && p.message).toContain("at most 128");
  });
  it("accepts exactly the cap", () => {
    const d = draft(
      ...Array.from(
        { length: MAX_GRANT_PERMISSIONS },
        (_, i) => `entity.k${i}.read`
      )
    );
    expect(validateGrantDraft(d)).toEqual({ ok: true });
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
    expect(s.sentence).toBe(`${GRANT_FULL_ACCESS_SENTENCE} · Never expires`);
    expect(GRANT_FULL_ACCESS_SENTENCE).toBe("Full access, approving included");
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
        everything: null,
        gates: [],
      },
      {
        key: "entity.note",
        subject: "entity",
        kind: "note",
        label: "Notes (mine)",
        actions: ["create", "update", "delete"],
        all: true,
        everything: "Read, create, update and delete",
        gates: [],
      },
    ]);
  });
  // Founder decision 2026-10-11: a bare subject is read/create/update/delete
  // ONLY. This replaces "Everything on Proposals, approving included" — that
  // pattern no longer approves, and saying so would overstate the grant.
  it("a bare subject reads as its four actions — never 'approving included'", () => {
    const proposals = resolveObjectNounPlural("proposal");
    const s = summarizeGrant(draft("proposal", "document.read"));
    const row = (key: string) => s.rows.find((r) => r.key === key);
    expect(row("proposal")).toMatchObject({
      all: true,
      everything: "Read, create, update and delete",
      gates: [],
    });
    expect(row("document")).toMatchObject({ all: false, everything: null });
    expect(s.what).toBe(
      `Read, create, update and delete ${proposals}; Read ${resolveObjectNounPlural("document")}`
    );
    expect(s.what).not.toContain("approving");
  });
  // Rules out: a named gate verb falling into "+1 more", or a bare row
  // claiming it.
  it("a named gate verb reads as its own verb, on its own row", () => {
    const s = summarizeGrant(
      draft("proposal.approve", "entity.note.merge", "entity.*.read"),
      { kindNames: { note: "Notes" } }
    );
    expect(s.other).toEqual([]);
    expect(s.rows.find((r) => r.key === "proposal")).toMatchObject({
      actions: [],
      all: false,
      gates: ["approve"],
    });
    expect(s.rows.find((r) => r.key === "entity.note")).toMatchObject({
      gates: ["merge"],
    });
    expect(s.what).toBe(
      `Read ${resolveObjectNounPlural("entity")}; Merge Notes; Approve ${resolveObjectNounPlural("proposal")}`
    );
  });
  it("only the pattern itself reads as everything — proposal.read stays Read", () => {
    const s = summarizeGrant(draft("proposal.read"));
    expect(s.rows[0]).toMatchObject({ all: false, everything: null });
    expect(s.what).toBe(`Read ${resolveObjectNounPlural("proposal")}`);
  });
  it("lists outside-catalog and invalid patterns instead of dropping them", () => {
    const s = summarizeGrant(draft("vault.redeem", "proposal.delete", "Bad"));
    expect(s.other).toEqual(["proposal.delete", "vault.redeem"]);
    expect(s.invalid).toEqual(["Bad"]);
  });
});

describe("summarizeGrant — a minted key's real expiry", () => {
  const d = draft("view.read");
  it("renders the date, not the 90-day default", () => {
    const s = summarizeGrant(d, { expiresAt: "2099-01-12T12:00:00.000Z" });
    expect(s.when).toBe("Until 12 Jan 2099");
    expect(s.sentence.endsWith("· Until 12 Jan 2099")).toBe(true);
    expect(s.expired).toBe(false);
    expect(
      summarizeGrant(d, { expiresAt: new Date("2099-01-12T12:00:00Z") }).when
    ).toBe("Until 12 Jan 2099");
  });
  it("null is never — and the lifetime says so", () => {
    const s = summarizeGrant(d, { expiresAt: null });
    expect(s.when).toBe("Never expires");
    expect(s.lifetime).toEqual({ kind: "never" });
  });
  it("a passed date is expired", () => {
    const s = summarizeGrant(d, { expiresAt: "2001-01-01T00:00:00Z" });
    expect([s.when, s.expired]).toEqual(["Expired", true]);
  });
  it("omitted keeps the draft's lifetime (a key not minted yet)", () => {
    expect(summarizeGrant(d).when).toBe("90 days");
    expect(summarizeGrant({ ...d, expiresInDays: 7 }).when).toBe("7 days");
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

describe("role ⇄ wire", () => {
  const stored: GrantRole = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Brand writer",
    description: "",
    stored: true,
    grant: {
      permissions: ["document.update", "entity.read"],
      workspaceIds: ["w1"],
      projectIds: ["p1"],
      expiresInDays: 30,
    },
  };

  // pod-admin's picker minted only {permissions, roleId}: a role made for the
  // Brand space minted a key for every space, valid for 90 days.
  it("a key from a stored role keeps its narrowing, lifetime and lineage", () => {
    expect(grantMintFromRole(stored)).toEqual({
      grant: {
        permissions: ["entity.*.read", "document.update"],
        workspaceIds: ["w1"],
        projectIds: ["p1"],
        roleId: stored.id,
      },
      expiresInDays: 30,
    });
  });
  it("a preset records no lineage and keeps the default lifetime", () => {
    expect(grantMintFromRole(GRANT_PRESETS[0])).toEqual({
      grant: { permissions: ["entity.*.read", "document.read", "view.read"] },
    });
  });
  it("a draft saved as a role keeps workspaces, projects and lifetime; drops the key label", () => {
    const d: GrantDraft = {
      ...stored.grant,
      label: "My key",
      expiresInDays: null,
    };
    expect(toGrantRoleInput("  Brand writer ", "  For the site ", d)).toEqual({
      name: "Brand writer",
      description: "For the site",
      grant: {
        permissions: ["entity.*.read", "document.update"],
        workspaceIds: ["w1"],
        projectIds: ["p1"],
        expiresInDays: null,
      },
    });
    expect(toGrantRoleInput("R", " ", draft("view.read"))).toEqual({
      name: "R",
      grant: { permissions: ["view.read"] },
    });
  });
  it("round-trips: a role saved from a draft mints what the draft mints", () => {
    const d: GrantDraft = { ...stored.grant };
    const saved = toGrantRoleInput("R", "", d);
    const role: GrantRole = {
      id: stored.id,
      name: saved.name,
      description: "",
      stored: true,
      grant: saved.grant,
    };
    expect(grantMintFromRole(role)).toEqual({
      ...toGrantMintInput(d),
      grant: { ...toGrantMintInput(d).grant, roleId: stored.id },
    });
  });
});
