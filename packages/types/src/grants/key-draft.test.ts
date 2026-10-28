import { describe, expect, it } from "vitest";
import {
  EMPTY_KEY_DRAFT,
  KEY_DRAFT_SECTIONS,
  KEY_POWERFUL_ACTIONS,
  KEY_LIFETIME_CHOICES,
  describeKey,
  describeKeyProblem,
  keyDraftFromTemplate,
  powerfulVerbs,
  setKeyGrant,
  setKeyUses,
  toKeyMintInput,
  validateKeyDraft,
  type KeyDraft,
} from "./key-draft.js";
import { GRANT_GATE_ACTIONS, parsePermission } from "./grammar.js";
import { DEV_LOOP_POSTER_TEMPLATE_ID, keyTemplate } from "./presets.js";
import { FULL_ACCESS_LABEL } from "./summary.js";

const poster = keyTemplate(DEV_LOOP_POSTER_TEMPLATE_ID)!;
const fromPoster = keyDraftFromTemplate(poster);

describe("the New key page's sections", () => {
  it("are in the plan's fixed order", () => {
    expect(KEY_DRAFT_SECTIONS.map((s) => s.label)).toEqual([
      "Start from",
      "Name and note",
      "Where it is used",
      "What it may touch",
      "Where",
      "Lifetime",
      "Review",
    ]);
    expect(KEY_LIFETIME_CHOICES).toEqual([1, 30, 90, 365]);
  });
});

describe("keyDraftFromTemplate", () => {
  it("takes the template's grant, lifetime, uses and name", () => {
    expect(fromPoster).toEqual({
      name: "Dev loop poster",
      uses: ["hub"],
      templateId: DEV_LOOP_POSTER_TEMPLATE_ID,
      grant: { permissions: ["event.create"], expiresInDays: 90 },
    });
  });

  it("keeps a name and note the person already typed", () => {
    const d = keyDraftFromTemplate(poster, {
      ...EMPTY_KEY_DRAFT,
      name: "devbox",
      note: "1Password › Dev",
    });
    expect(d.name).toBe("devbox");
    expect(d.note).toBe("1Password › Dev");
  });

  it("orders uses as KEY_USES does and drops duplicates", () => {
    expect(setKeyUses(fromPoster, ["chat", "hub", "chat"]).uses).toEqual([
      "hub",
      "chat",
    ]);
  });
});

describe("describeKey", () => {
  it("the poster reads as its door and one Activity write, no danger mark", () => {
    const d = describeKey(fromPoster);
    expect(d.uses).toEqual([
      { id: "hub", label: "A website or app (Hub API)" },
    ]);
    expect(d.scopes).toEqual(["hub-protocol.read", "hub-protocol.write"]);
    expect(d.writes).toBe(true);
    expect(d.marks).toEqual([]);
    expect(d.summary.what).toBe("Create Activity");
    expect(d.sentence).toBe(
      "A website or app (Hub API) · Create Activity · 90 days"
    );
  });

  it("marks full access, powerful actions and a key that never expires", () => {
    const full = describeKey(
      setKeyGrant(fromPoster, { permissions: ["*"], expiresInDays: null })
    );
    expect(full.marks.map((m) => m.code)).toEqual([
      "full-access",
      "never-expires",
    ]);
    expect(full.marks[0].label).toBe(FULL_ACCESS_LABEL);
    const powerful = describeKey(
      setKeyGrant(fromPoster, {
        permissions: ["proposal.approve", "view.delete", "entity.note"],
      })
    );
    expect(powerful.marks).toEqual([
      {
        code: "powerful-actions",
        label: "Powerful actions: Approve, Delete",
        verbs: ["approve", "delete"],
      },
    ]);
  });

  it("a bare subject counts as a delete; reads and creates do not", () => {
    expect(powerfulVerbs(["entity.note"])).toEqual(["delete"]);
    expect(
      powerfulVerbs(["entity.*.read", "event.create", "document.update"])
    ).toEqual([]);
    expect(powerfulVerbs(["*"])).toEqual([]);
  });

  it("each powerful action on the page is a gate verb its own pattern names, and marks", () => {
    expect(KEY_POWERFUL_ACTIONS.map((a) => a.pattern)).toEqual([
      "proposal.approve",
      "entity.*.merge",
      "entity.*.archive",
      "entity.*.purge",
    ]);
    for (const a of KEY_POWERFUL_ACTIONS) {
      const segs = parsePermission(a.pattern);
      expect(segs[0]).toBe(a.subject);
      expect(segs[segs.length - 1]).toBe(a.verb);
      expect(GRANT_GATE_ACTIONS as readonly string[]).toContain(a.verb);
      expect(powerfulVerbs([a.pattern])).toEqual([a.verb]);
    }
  });

  it("a read-only draft derives no write scope", () => {
    const d = describeKey(
      setKeyGrant(setKeyUses(fromPoster, ["hub", "mcp"]), {
        permissions: ["entity.*.read"],
      })
    );
    expect(d.writes).toBe(false);
    expect(d.scopes).toEqual(["hub-protocol.read", "mcp.read"]);
  });
});

describe("validateKeyDraft", () => {
  it("a template draft is valid as it comes", () => {
    expect(validateKeyDraft(fromPoster)).toEqual({ ok: true });
  });

  it("names every problem at once", () => {
    const bad: KeyDraft = {
      name: "  ",
      uses: ["bogus"],
      grant: { permissions: [], expiresInDays: 0 },
    };
    const v = validateKeyDraft(bad);
    expect(v.ok).toBe(false);
    const codes = v.ok ? [] : v.problems.map((p) => p.code);
    expect(codes).toEqual(["no-name", "unknown-use", "grant", "grant"]);
    expect(
      validateKeyDraft({ ...fromPoster, uses: [] }).ok ? [] : ["no-uses"]
    ).toEqual(["no-uses"]);
  });

  describe("under a ceiling (a CLI request: narrow, never widen)", () => {
    const ceiling = { grant: poster.grant, uses: poster.uses ?? [] };
    const problems = (d: KeyDraft) => {
      const v = validateKeyDraft(d, { ceiling });
      return v.ok ? [] : v.problems;
    };

    it("the template itself, or narrower, is within", () => {
      expect(problems(fromPoster)).toEqual([]);
      expect(
        problems(
          setKeyGrant(fromPoster, {
            permissions: ["event.create"],
            workspaceIds: ["ws-1"],
            expiresInDays: 1,
          })
        )
      ).toEqual([]);
    });

    it("more permissions, another door or a longer life is refused", () => {
      expect(
        problems(
          setKeyGrant(fromPoster, {
            permissions: ["event.create", "entity.*.read"],
            expiresInDays: 90,
          })
        )
      ).toEqual([{ code: "wider-than-ceiling", axis: "permissions" }]);
      expect(problems(setKeyUses(fromPoster, ["hub", "mcp"]))).toEqual([
        { code: "wider-than-ceiling", axis: "uses" },
      ]);
      expect(
        problems(
          setKeyGrant(fromPoster, {
            permissions: ["event.create"],
            expiresInDays: null,
          })
        )
      ).toEqual([{ code: "wider-than-ceiling", axis: "lifetime" }]);
      expect(
        problems(
          setKeyGrant(fromPoster, {
            permissions: ["event.create"],
            expiresInDays: 91,
          })
        )
      ).toEqual([{ code: "wider-than-ceiling", axis: "lifetime" }]);
    });

    it("a ceiling pinned to a space refuses an unpinned draft", () => {
      const v = validateKeyDraft(fromPoster, {
        ceiling: {
          grant: { ...poster.grant, workspaceIds: ["ws-1"] },
          uses: ["hub"],
        },
      });
      expect(v).toEqual({
        ok: false,
        problems: [{ code: "wider-than-ceiling", axis: "permissions" }],
      });
    });
  });
});

describe("describeKeyProblem", () => {
  const SECTION_IDS = KEY_DRAFT_SECTIONS.map((s) => s.id as string);

  it("every problem points at a section of the page and reads as words", () => {
    const v = validateKeyDraft(
      {
        name: "",
        uses: [],
        grant: { permissions: ["Bad..x"], expiresInDays: 0 },
      },
      { ceiling: { grant: poster.grant, uses: [] } }
    );
    const problems = v.ok ? [] : v.problems;
    expect(problems.length).toBeGreaterThanOrEqual(4);
    for (const p of problems) {
      const { section, text } = describeKeyProblem(p);
      expect(SECTION_IDS).toContain(section);
      expect(text.trim()).not.toBe("");
    }
  });

  it("sends each problem to the section that fixes it", () => {
    expect(describeKeyProblem({ code: "no-name" }).section).toBe("name");
    expect(describeKeyProblem({ code: "no-uses" }).section).toBe("uses");
    expect(
      describeKeyProblem({ code: "wider-than-ceiling", axis: "permissions" })
        .section
    ).toBe("access");
    expect(
      describeKeyProblem({ code: "wider-than-ceiling", axis: "lifetime" })
        .section
    ).toBe("lifetime");
    expect(
      describeKeyProblem({
        code: "grant",
        problem: { code: "invalid-lifetime", days: 0 },
      }).section
    ).toBe("lifetime");
  });
});

describe("toKeyMintInput", () => {
  it("carries uses, never scopes, plus the grant's mint shape", () => {
    const m = toKeyMintInput({ ...fromPoster, note: " vault " });
    expect(m).toEqual({
      name: "Dev loop poster",
      uses: ["hub"],
      note: "vault",
      templateId: DEV_LOOP_POSTER_TEMPLATE_ID,
      grant: { permissions: ["event.create"] },
      expiresInDays: 90,
    });
    expect("scope" in m || "scopes" in m).toBe(false);
  });

  it("drops an unknown use (validation reports it first)", () => {
    expect(
      toKeyMintInput(setKeyUses(fromPoster, ["hub", "bogus"])).uses
    ).toEqual(["hub"]);
  });
});
