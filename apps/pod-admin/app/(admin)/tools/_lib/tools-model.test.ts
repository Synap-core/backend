import { describe, expect, it } from "vitest";
import type { CardLike, CompositionLike } from "./installed-model";
import {
  filterTools,
  initialToolsView,
  isRuleSkill,
  legacyToolsHref,
  matchesToolSearch,
  skillToolType,
  storeToolsView,
  TOOLS_VIEW_KEY,
  toolCounts,
  toolFilterOf,
  toolItems,
  toolSecondary,
  toolWhere,
  type SkillLike,
} from "./tools-model";

const CAP = "11111111-1111-4111-8111-111111111111";
const CAP_OFF = "22222222-2222-4222-8222-222222222222";
const VERB_SKILL = "33333333-3333-4333-8333-333333333333";
const MEMBER_SKILL = "44444444-4444-4444-8444-444444444444";

function comp(over: Partial<CompositionLike> = {}): CompositionLike {
  return {
    id: CAP,
    name: "Gmail",
    description: "Read and send mail",
    workspaceId: null,
    members: [
      { kind: "skill", id: VERB_SKILL, wired: true },
      { kind: "automation", id: "a1", name: "Inbox sweep", wired: true },
    ],
    health: { status: "ok", failedRuns: 0, stuckRuns: 0 },
    gaps: [],
    ...over,
  };
}

function card(over: Partial<CardLike> = {}): CardLike {
  return {
    id: CAP,
    name: "Gmail",
    status: "ready",
    source: "installed",
    verbs: [
      {
        verbId: "gmail_send",
        skillId: VERB_SKILL,
        label: "Send email",
        type: "action",
        enabled: true,
      },
    ],
    ...over,
  };
}

function skill(over: Partial<SkillLike> = {}): SkillLike {
  return {
    id: "s-instr",
    name: "Dogfood journal",
    slug: "rules/dogfood-journal",
    kind: "instruction",
    description: "File what you hit",
    approved: true,
    scope: "pod",
    workspaceId: null,
    metadata: {},
    ...over,
  };
}

describe("skillToolType — which type a skill is listed as", () => {
  const none = new Set<string>();
  it("an instruction is Instructions; code, declarative and builtin are Code", () => {
    expect(skillToolType(skill(), none)).toBe("instruction");
    for (const kind of ["code", "declarative", "builtin"])
      expect(skillToolType(skill({ kind }), none)).toBe("code");
  });

  it("a rule is left out: it has its own page (wrong rule: every instruction is listed)", () => {
    const rule = skill({ metadata: { rule: { intent: "x" } } });
    expect(isRuleSkill(rule)).toBe(true);
    expect(skillToolType(rule, none)).toBeNull();
    // A skill with metadata but no rule is still listed.
    expect(skillToolType(skill({ metadata: { other: 1 } }), none)).toBe(
      "instruction"
    );
  });

  it("a skill that backs a capability action is not Code (wrong rule: every code skill is Code)", () => {
    const action = skill({ id: VERB_SKILL, kind: "code" });
    expect(skillToolType(action, new Set([VERB_SKILL]))).toBeNull();
    expect(skillToolType(action, none)).toBe("code");
  });

  it("a kind with no type is not listed", () => {
    expect(skillToolType(skill({ kind: "mystery" }), none)).toBeNull();
  });
});

describe("toolItems — the one list", () => {
  const skills: SkillLike[] = [
    skill(),
    skill({ id: VERB_SKILL, name: "gmail_send", kind: "code" }),
    skill({ id: MEMBER_SKILL, name: "member only", kind: "code" }),
    skill({ id: "s-code", name: "CSV chart", slug: null, kind: "code" }),
    skill({ id: "s-rule", name: "A rule", metadata: { rule: {} } }),
  ];

  it("capabilities, instructions and standalone code; actions and rules left out", () => {
    const items = toolItems({
      compositions: [
        comp({
          members: [
            { kind: "skill", id: VERB_SKILL, wired: true },
            { kind: "skill", id: MEMBER_SKILL, wired: false },
          ],
        }),
      ],
      cards: [card()],
      skills,
    });
    expect(items.map((i) => i.key).sort()).toEqual(
      ["capability:" + CAP, "code:s-code", "instruction:s-instr"].sort()
    );
  });

  it("an action stays out even when the catalog read failed (members still name it)", () => {
    const items = toolItems({ compositions: [comp()], cards: null, skills });
    expect(items.map((i) => i.id)).not.toContain(VERB_SKILL);
    const cap = items.find((i) => i.id === CAP)!;
    // Unknown, never On or "0 of 0".
    expect(cap.status.kind).toBe("unknown");
    expect(cap.actionsOn).toBeNull();
  });

  it("each row opens its own page", () => {
    const items = toolItems({
      compositions: [comp()],
      cards: [card()],
      skills: [skill()],
    });
    expect(items.find((i) => i.type === "capability")!.href).toBe(
      `/open/capability/${CAP}`
    );
    expect(items.find((i) => i.type === "instruction")!.href).toBe(
      "/open/skill/s-instr"
    );
  });

  it("what needs a look comes first, then by name", () => {
    const items = toolItems({
      compositions: [
        comp({ name: "Zeta" }),
        comp({ id: CAP_OFF, name: "Beta" }),
      ],
      cards: [
        card({ name: "Zeta", status: "ready" }),
        card({ id: CAP_OFF, name: "Beta", status: "draft" }),
      ],
      skills: [
        skill({ name: "Alpha", approved: false }),
        skill({ id: "x", name: "Aardvark" }),
      ],
    });
    expect(items.map((i) => i.name)).toEqual([
      "Alpha",
      "Beta",
      "Aardvark",
      "Zeta",
    ]);
  });
});

describe("search, filter and counts", () => {
  const items = toolItems({
    compositions: [comp()],
    cards: [card()],
    skills: [
      skill(),
      skill({
        id: "s-code",
        name: "CSV chart",
        slug: null,
        kind: "code",
        description: null,
      }),
    ],
  });

  it("matches name, slug, description and action labels, any case", () => {
    const gmail = items.find((i) => i.type === "capability")!;
    expect(matchesToolSearch(gmail, "GMAIL")).toBe(true);
    expect(matchesToolSearch(gmail, "send email")).toBe(true); // action label
    expect(matchesToolSearch(gmail, "gmail_send")).toBe(true); // verb id
    expect(matchesToolSearch(gmail, "mail read")).toBe(true); // description words
    expect(matchesToolSearch(gmail, "csv")).toBe(false);
    const journal = items.find((i) => i.type === "instruction")!;
    expect(matchesToolSearch(journal, "rules/dogfood")).toBe(true); // slug
  });

  it("filters by type and search together", () => {
    expect(filterTools(items, "all", "").length).toBe(3);
    expect(filterTools(items, "capabilities", "").map((i) => i.type)).toEqual([
      "capability",
    ]);
    expect(filterTools(items, "instructions", "").map((i) => i.id)).toEqual([
      "s-instr",
    ]);
    expect(filterTools(items, "code", "").map((i) => i.id)).toEqual(["s-code"]);
    expect(filterTools(items, "code", "gmail")).toEqual([]);
  });

  it("chip counts follow the search", () => {
    expect(toolCounts(items, "")).toEqual({
      all: 3,
      capabilities: 1,
      instructions: 1,
      code: 1,
    });
    expect(toolCounts(items, "gmail")).toEqual({
      all: 1,
      capabilities: 1,
      instructions: 0,
      code: 0,
    });
  });

  it("?type= reads its four values, anything else is All", () => {
    expect(toolFilterOf("instructions")).toBe("instructions");
    expect(toolFilterOf("actions")).toBe("all");
    expect(toolFilterOf(null)).toBe("all");
  });
});

describe("where and the second line", () => {
  it("names the whole pod, one person, or the space", () => {
    const names = (id: string) => (id === "w1" ? "Sales" : undefined);
    expect(toolWhere({ scope: "pod", workspaceId: null }, names)).toBe(
      "Whole pod"
    );
    expect(toolWhere({ scope: "user", workspaceId: null }, names)).toBe(
      "Only you"
    );
    expect(toolWhere({ scope: "workspace", workspaceId: "w1" }, names)).toBe(
      "Sales"
    );
    expect(toolWhere({ scope: "workspace", workspaceId: "w2" }, names)).toBe(
      "A space"
    );
  });

  it("a capability says how many actions are on", () => {
    const [cap] = toolItems({
      compositions: [comp()],
      cards: [card()],
      skills: [],
    });
    expect(toolSecondary(cap!, "Whole pod")).toBe(
      "Whole pod · 1 of 1 actions on"
    );
  });
});

describe("the view: URL first, then this viewer's choice, then the list", () => {
  const storage = (value: string | null) => ({ getItem: () => value });
  it("reads the URL, then storage, then list", () => {
    expect(initialToolsView("gallery", storage("list"))).toBe("gallery");
    expect(initialToolsView(null, storage("gallery"))).toBe("gallery");
    expect(initialToolsView(null, storage(null))).toBe("list");
    expect(initialToolsView(null, undefined)).toBe("list");
  });

  it("a storage that throws is the list, never a crash", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(initialToolsView(null, throwing)).toBe("list");
    expect(() => storeToolsView("gallery", throwing)).not.toThrow();
  });

  it("keeps the choice under its key", () => {
    const kept = new Map<string, string>();
    storeToolsView("gallery", { setItem: (k, v) => void kept.set(k, v) });
    expect(kept.get(TOOLS_VIEW_KEY)).toBe("gallery");
  });
});

describe("legacyToolsHref — old ?tab= links", () => {
  const href = (qs: string) => legacyToolsHref(new URLSearchParams(qs));
  it("no tab, nothing to do", () => {
    expect(href("type=code")).toBeNull();
  });
  it("Actions or Installed focused on a capability open its page", () => {
    expect(href(`tab=actions&focus=${CAP}`)).toBe(`/open/capability/${CAP}`);
    expect(href(`tab=installed&focus=${CAP}`)).toBe(`/open/capability/${CAP}`);
  });
  it("Installed and Actions are the Capabilities filter; Skills is the whole list", () => {
    expect(href("tab=actions")).toBe("/tools?type=capabilities");
    expect(href("tab=installed&view=gallery")).toBe(
      "/tools?view=gallery&type=capabilities"
    );
    expect(href("tab=skills")).toBe("/tools");
  });
});
