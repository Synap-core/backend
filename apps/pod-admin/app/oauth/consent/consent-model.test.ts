import { describe, expect, it } from "vitest";
import {
  FULL_ACCESS_LABEL,
  GRANT_GATE_ACTIONS,
} from "@synap-core/types/grants";

import {
  actsAsHeadline,
  allowBlockedReason,
  consentClientKind,
  consentWidth,
  initialSelection,
  invalidRequestHint,
  isTicked,
  permissionLabel,
  readsSpaceRecords,
  reasonOf,
  SPACE_REACH_NOTE,
  sectionCheckboxLabel,
  sectionState,
  spaceCheckboxLabel,
  spaceHintFirst,
  splitOffer,
  toApproved,
  toggle,
  toggleSection,
  withoutSpace,
  defaultSpaces,
  ALSO_SEE,
  alsoSeeLine,
  decideLine,
  decisionsHeading,
  FULL_ACCESS,
  groupByObject,
  isDecisionPermission,
  levelControlLabel,
  PRESELECT_DECISIONS,
  objectLevel,
  objectSpaces,
  otherSpaces,
  podWideNote,
  scopeLabel,
  setObjectLevel,
  shownSpaces,
  toggleObjectSpace,
  newAsks,
  newAsksAllowed,
  allowNewAsks,
  type OfferedPermission,
  type Selection,
} from "./consent-model";

const OFFER: OfferedPermission[] = [
  {
    permission: "entity.post.read",
    workspaces: [
      { workspaceId: "brand", workspaceName: "Brand" },
      { workspaceId: "shared", workspaceName: "Shared" },
    ],
  },
  {
    permission: "entity.post.create",
    workspaces: [{ workspaceId: "brand", workspaceName: "Brand" }],
  },
  { permission: "document.update", workspaces: [] },
];

describe("consent selection — narrow only", () => {
  it("first consent: everything asked starts ticked, in every space on offer", () => {
    const s = initialSelection(OFFER, []);
    expect(toApproved(s, OFFER)).toEqual([
      { permission: "entity.post.read", workspaceId: "brand" },
      { permission: "entity.post.read", workspaceId: "shared" },
      { permission: "entity.post.create", workspaceId: "brand" },
    ]);
    // Exactly the offer: the state holds no pair beyond what Allow sends.
    expect(s.size).toBe(3);
  });

  it("re-consent pre-ticks the current approval, dropping what is no longer on offer", () => {
    const s = initialSelection(OFFER, [
      { permission: "entity.post.read", workspaceId: "shared" },
      { permission: "entity.post.create", workspaceId: "gone" },
    ]);
    expect(toApproved(s, OFFER)).toEqual([
      { permission: "entity.post.read", workspaceId: "shared" },
    ]);
  });

  it("re-consent ticks nothing the person did not approve, new ask or old no alike", () => {
    // The pod keeps what they approved, not what they were asked: a pair
    // missing from it may be a "no" they gave last time.
    const s = initialSelection(OFFER, [
      { permission: "entity.post.read", workspaceId: "brand" },
    ]);
    expect(isTicked(s, "entity.post.read", "shared")).toBe(false);
    expect(isTicked(s, "entity.post.create", "brand")).toBe(false);
    expect(s.size).toBe(1);
  });

  it("unticking narrows; ticking an offered pair adds it", () => {
    let s: Selection = new Set();
    s = toggle(s, OFFER, "entity.post.create", "brand");
    expect(isTicked(s, "entity.post.create", "brand")).toBe(true);
    s = toggle(s, OFFER, "entity.post.create", "brand");
    expect(toApproved(s, OFFER)).toEqual([]);
  });

  it("a pair the offer does not hold can never be ticked (no widening)", () => {
    let s = initialSelection(OFFER, []);
    s = toggle(s, OFFER, "entity.post.create", "shared");
    s = toggle(s, OFFER, "entity.post.delete", "brand");
    s = toggle(s, OFFER, "document.update", "brand");
    // Not even held in the screen's state (what the checkboxes render from).
    expect(isTicked(s, "entity.post.create", "shared")).toBe(false);
    expect(isTicked(s, "entity.post.delete", "brand")).toBe(false);
    expect(isTicked(s, "document.update", "brand")).toBe(false);
    expect(s.size).toBe(3);
  });

  it("what Allow sends is filtered to the offer even from a forged selection", () => {
    const forged = new Set([
      "entity.post.read\u0000brand",
      "*\u0000brand",
      "entity.post.create\u0000elsewhere",
    ]);
    expect(toApproved(forged, OFFER)).toEqual([
      { permission: "entity.post.read", workspaceId: "brand" },
    ]);
  });

  it("names the permissions the person has no space for", () => {
    expect(withoutSpace(OFFER).map((o) => o.permission)).toEqual([
      "document.update",
    ]);
  });
});

describe("permissionLabel", () => {
  it.each([
    ["entity.post.read", "Read posts"],
    ["entity.post.create", "Create posts"],
    ["entity.story.update", "Edit stories"],
    ["entity.read", "Read everything in it"],
    ["entity.*.read", "Read everything in it"],
    ["document.update", "Edit documents"],
    ["document.read", "Read documents"],
    ["proposal.approve", "Approve changes waiting for your review"],
    ["proposal.reject", "Reject changes waiting for your review"],
    // Everything an agent key may hold (apps = agents, 2026-10-26), nouns
    // and verbs from the vocabulary door.
    ["playbook.run", "Run templates"],
    ["capability.run", "Run tools"],
    ["tool.create", "Create tools"],
    ["entity.deal.transition", "Move deals"],
    ["entity.person.read", "Read people"],
    ["entity.post", "Read, create, edit and delete posts"],
    ["entity.*", "Read, create, edit and delete everything in it"],
    ["*", FULL_ACCESS_LABEL],
  ])("%s → %s", (permission, label) => {
    expect(permissionLabel(permission)).toBe(label);
  });
});

describe("the reach line under the space choice", () => {
  const offer = (...permissions: string[]): OfferedPermission[] =>
    permissions.map((permission) => ({ permission, workspaces: [] }));

  it("shows for ANY entity read, whatever the kind (the reach has no kind limit)", () => {
    for (const p of [
      "entity.read",
      "entity.*.read",
      "entity.person.read",
      "entity.post.read",
      "entity.post",
      "entity",
      "*",
    ])
      expect(readsSpaceRecords(offer(p)), p).toBe(true);
    expect(readsSpaceRecords(OFFER)).toBe(true); // entity.post.read
  });

  it("not for an app that reads no records (writes only, documents only)", () => {
    expect(
      readsSpaceRecords(offer("entity.person.create", "document.read"))
    ).toBe(false);
    expect(readsSpaceRecords(offer("not a permission"))).toBe(false);
  });

  it("says what a member sees, and that nothing else is reached (rv-ui U1)", () => {
    expect(SPACE_REACH_NOTE).toBe(
      "It sees what a member of these spaces sees: what is stored there, plus the people, companies and other records of your pod that have a role there. Nothing else in your pod."
    );
    expect(SPACE_REACH_NOTE).not.toContain("\u2014");
  });
});

describe("a Synap app's headline — the spaces ticked are the grant", () => {
  const LEAD = "Content Studio will act as you in";
  it("names each ticked space once, in offer order, and follows the ticks", () => {
    let s = initialSelection(OFFER, []);
    expect(actsAsHeadline(LEAD, s, OFFER)).toBe(
      "Content Studio will act as you in: Brand, Shared."
    );
    s = toggle(s, OFFER, "entity.post.read", "shared");
    expect(actsAsHeadline(LEAD, s, OFFER)).toBe(
      "Content Studio will act as you in: Brand."
    );
    s = toggle(s, OFFER, "entity.post.read", "shared");
    s = toggle(s, OFFER, "entity.post.create", "brand");
    s = toggle(s, OFFER, "entity.post.read", "brand");
    expect(actsAsHeadline(LEAD, s, OFFER)).toBe(
      "Content Studio will act as you in: Shared."
    );
  });

  it("nothing ticked: no space is named", () => {
    expect(actsAsHeadline(LEAD, new Set(), OFFER)).toBe(
      "Content Studio will act as you in the spaces you choose below."
    );
  });
});

describe("a decision (approve / reject) is never folded into a write", () => {
  const WITH_DECISIONS: OfferedPermission[] = [
    {
      permission: "entity.post.create",
      workspaces: [{ workspaceId: "brand", workspaceName: "Brand" }],
    },
    {
      permission: "proposal.approve",
      workspaces: [{ workspaceId: "brand", workspaceName: "Brand" }],
    },
    {
      permission: "proposal.reject",
      workspaces: [{ workspaceId: "brand", workspaceName: "Brand" }],
    },
  ];

  it("is listed apart from the reads and writes", () => {
    const { grants, decisions } = splitOffer(WITH_DECISIONS);
    expect(grants.map((o) => o.permission)).toEqual(["entity.post.create"]);
    expect(decisions.map((o) => o.permission)).toEqual([
      "proposal.approve",
      "proposal.reject",
    ]);
  });

  it("first consent: every write starts ticked, a decision does not (PRESELECT_DECISIONS)", () => {
    const s = initialSelection(WITH_DECISIONS, []);
    expect(toApproved(s, WITH_DECISIONS)).toEqual([
      { permission: "entity.post.create", workspaceId: "brand" },
    ]);
  });

  it("the person ticks it space by space; a re-consent keeps their choice", () => {
    let s = initialSelection(WITH_DECISIONS, []);
    s = toggle(s, WITH_DECISIONS, "proposal.approve", "brand");
    const approved = toApproved(s, WITH_DECISIONS);
    expect(approved).toContainEqual({
      permission: "proposal.approve",
      workspaceId: "brand",
    });
    expect(
      toApproved(initialSelection(WITH_DECISIONS, approved), WITH_DECISIONS)
    ).toEqual(approved);
  });
});

describe("a whole section selects or clears at once", () => {
  const MIXED: OfferedPermission[] = [
    {
      permission: "entity.post.read",
      workspaces: [
        { workspaceId: "brand", workspaceName: "Brand" },
        { workspaceId: "shared", workspaceName: "Shared" },
      ],
    },
    {
      permission: "entity.post.create",
      workspaces: [{ workspaceId: "brand", workspaceName: "Brand" }],
    },
    {
      permission: "proposal.approve",
      workspaces: [
        { workspaceId: "brand", workspaceName: "Brand" },
        { workspaceId: "shared", workspaceName: "Shared" },
      ],
    },
  ];
  const { grants, decisions } = splitOffer(MIXED);

  it("reads all, some or none over the section's spaces", () => {
    const first = initialSelection(MIXED, []);
    expect(sectionState(first, grants)).toBe("all");
    expect(sectionState(first, decisions)).toBe("none");
    const one = toggle(first, MIXED, "entity.post.read", "shared");
    expect(sectionState(one, grants)).toBe("some");
  });

  it("a section with no space to give reads none", () => {
    expect(
      sectionState(new Set(), [{ permission: "x.read", workspaces: [] }])
    ).toBe("none");
  });

  it("all → none; some → all; none → all", () => {
    let s = initialSelection(MIXED, []);
    s = toggleSection(s, MIXED, grants);
    expect(sectionState(s, grants)).toBe("none");
    expect(toApproved(s, MIXED)).toEqual([]);
    s = toggle(s, MIXED, "entity.post.create", "brand");
    s = toggleSection(s, MIXED, grants);
    expect(sectionState(s, grants)).toBe("all");
    s = toggleSection(s, MIXED, decisions);
    expect(sectionState(s, decisions)).toBe("all");
    expect(toApproved(s, MIXED)).toHaveLength(5);
  });

  it("touches only its own section", () => {
    let s = toggleSection(new Set(), MIXED, decisions);
    expect(sectionState(s, grants)).toBe("none");
    s = toggleSection(s, MIXED, grants);
    s = toggleSection(s, MIXED, grants);
    expect(sectionState(s, decisions)).toBe("all");
    expect(sectionState(s, grants)).toBe("none");
  });

  it("never ticks a pair the offer does not hold (no widening)", () => {
    const forged: OfferedPermission[] = [
      {
        permission: "entity.post.delete",
        workspaces: [{ workspaceId: "brand", workspaceName: "Brand" }],
      },
      {
        permission: "entity.post.read",
        workspaces: [{ workspaceId: "elsewhere", workspaceName: "Elsewhere" }],
      },
    ];
    const s = toggleSection(new Set(), MIXED, forged);
    expect(s.size).toBe(0);
  });

  it("its checkbox says what it selects, starting with its visible label", () => {
    expect(sectionCheckboxLabel("grants")).toBe(
      "All it asks to do, in every space"
    );
    expect(sectionCheckboxLabel("decisions")).toBe(
      "All its decisions, in every space"
    );
  });
});

describe("consent space hint (order only, never a grant)", () => {
  it("lists the hinted space first where a permission offers it", () => {
    const out = spaceHintFirst(OFFER, "shared");
    expect(out[0]!.workspaces.map((w) => w.workspaceId)).toEqual([
      "shared",
      "brand",
    ]);
    // Not offered there: that permission is left as it is.
    expect(out[1]!.workspaces.map((w) => w.workspaceId)).toEqual(["brand"]);
    expect(out[2]!.workspaces).toEqual([]);
  });

  it("never adds a space the offer does not hold", () => {
    const out = spaceHintFirst(OFFER, "someone-elses-space");
    expect(out).toEqual(OFFER);
    const s = initialSelection(out, []);
    expect(isTicked(s, "entity.post.read", "someone-elses-space")).toBe(false);
    expect(toApproved(s, out)).toHaveLength(3);
  });

  it("a re-consent keeps the current approval; the hint never adds to it", () => {
    const s = initialSelection(spaceHintFirst(OFFER, "shared"), [
      { permission: "entity.post.read", workspaceId: "brand" },
    ]);
    expect(toApproved(s, OFFER)).toEqual([
      { permission: "entity.post.read", workspaceId: "brand" },
    ]);
  });
});

describe("the consent card's width", () => {
  it("a pod app's consent reads wider; every other consent is one decision", () => {
    expect(consentWidth("https://studio.example.com/synap/client.json")).toBe(
      "md"
    );
    expect(consentWidth("synap-desktop")).toBe("sm");
    expect(consentWidth("app_1a2b3c")).toBe("sm");
    expect(consentWidth("3f2c9a10-dcr-client")).toBe("sm");
  });
});

describe("Allow says why it is disabled", () => {
  it("nothing ticked: Allow is blocked, with a reason", () => {
    expect(allowBlockedReason(OFFER, new Set())).toBe(
      "Turn on at least one thing it asks for."
    );
  });

  it("no space at all on offer: a different reason", () => {
    expect(
      allowBlockedReason([{ permission: "x.read", workspaces: [] }], new Set())
    ).toBe("You have no space to give it yet.");
  });

  it("one pair ticked: Allow may be pressed", () => {
    const s = toggle(new Set(), OFFER, "entity.post.create", "brand");
    expect(allowBlockedReason(OFFER, s)).toBeNull();
  });

  it("a section cleared at once blocks Allow, with the same reason", () => {
    const { grants } = splitOffer(OFFER);
    const s = toggleSection(initialSelection(OFFER, []), OFFER, grants);
    expect(allowBlockedReason(OFFER, s)).toBe(
      "Turn on at least one thing it asks for."
    );
  });

  it("a ticked pair outside the offer does not unblock it", () => {
    const forged = new Set(["entity.post.read\u0000elsewhere"]);
    expect(allowBlockedReason(OFFER, forged)).not.toBeNull();
  });
});

describe("space checkbox names and reasons", () => {
  it("names the permission AND the space", () => {
    expect(spaceCheckboxLabel("entity.post.read", "Brand")).toBe(
      "Read posts in Brand"
    );
  });

  it("reads the developer's reason, or none", () => {
    expect(
      reasonOf({
        permission: "a.read",
        workspaces: [],
        reason: "  To list posts. ",
      })
    ).toBe("To list posts.");
    expect(
      reasonOf({ permission: "a.read", workspaces: [], reason: " " })
    ).toBeNull();
    expect(reasonOf({ permission: "a.read", workspaces: [] })).toBeNull();
  });
});

describe("the invalid-request hint fits the client", () => {
  const POD_APP = "https://studio.example.com/synap/client.json";
  it.each([
    [POD_APP, "pod_app"],
    ["app_1a2b3c", "sign_in"],
    ["synap-desktop", "first_party"],
    ["3f2c9a10-dcr-client", "mcp"],
    // An inherited key is not a Synap app.
    ["constructor", "mcp"],
  ] as const)("%s is %s", (clientId, kind) => {
    expect(consentClientKind(clientId)).toBe(kind);
  });

  it("a pod app or a sign-in is never told to go back to Claude", () => {
    expect(invalidRequestHint(POD_APP)).not.toMatch(/claude/i);
    expect(invalidRequestHint(POD_APP)).toMatch(/website/);
    expect(invalidRequestHint("app_1a2b3c")).not.toMatch(/claude/i);
  });

  it("a Synap app is named, not Claude", () => {
    expect(invalidRequestHint("synap-desktop")).toMatch(/from Synap Desktop/);
    expect(invalidRequestHint("synap-desktop")).not.toMatch(/claude/i);
  });

  it("an MCP client keeps the Claude wording", () => {
    expect(invalidRequestHint("3f2c9a10-dcr-client")).toMatch(/from Claude/);
  });

  it("no hint uses an em dash", () => {
    for (const id of [POD_APP, "app_1a2b3c", "synap-desktop", "x"]) {
      expect(invalidRequestHint(id)).not.toContain("\u2014");
    }
  });
});

// ─── Object-first rows (founder, 2026-10-23) ─────────────────────────────────

/** The spaces of the render test: two from Content Studio's templates. */
const CO = {
  workspaceId: "co",
  workspaceName: "Content OS",
  templateSlug: "content-os",
};
const ECO = {
  workspaceId: "eco",
  workspaceName: "Ecosystem",
  templateSlug: "ecosystem",
};
const BRAND_S = {
  workspaceId: "brand",
  workspaceName: "Brand",
  templateSlug: null,
};
const BUILDER = {
  workspaceId: "builder",
  workspaceName: "Builder",
  templateSlug: "builder-workspace",
};
const ALL4 = [BRAND_S, BUILDER, CO, ECO];
const TEMPLATES = ["content-os", "ecosystem"];

/**
 * Content Studio's real ask (https://content-studio.synap.live/.well-known/
 * synap-client.json, read 2026-10-23), every space readable and writable.
 */
const STUDIO_ASK = [
  "entity.post.read",
  "entity.pillar.read",
  "entity.journey-stage.read",
  "entity.series.read",
  "entity.platform.read",
  "entity.file.read",
  "entity.content-composition.read",
  "entity.content-asset.read",
  "entity.inspiration.read",
  "entity.signal_item.read",
  "document.read",
  "relation.read",
  "session.read",
  "proposal.read",
  "entity.post.create",
  "entity.post.update",
  "entity.signal_item.update",
  "entity.file.create",
];
const STUDIO: OfferedPermission[] = STUDIO_ASK.map((permission) => ({
  permission,
  workspaces: ALL4,
}));

const ids = (spaces: readonly { workspaceId: string }[]) =>
  spaces.map((w) => w.workspaceId);
/** A row by key: a top-level row, or an object folded into "It can also see". */
const row = (offer: OfferedPermission[], key: string) => {
  const r = groupByObject(offer)
    .flatMap((o) => [o, ...o.members])
    .find((o) => o.key === key);
  expect(r, `no row ${key}`).toBeDefined();
  return r!;
};

describe("rows group the ask by object", () => {
  it("one row per object it may edit, then ONE row for all it only views; words from the vocabulary door", () => {
    const rows = groupByObject(STUDIO);
    expect(rows.map((r) => [r.label, r.levels.join("/")])).toEqual([
      ["Posts", "off/view/edit"],
      ["Files", "off/view/edit"],
      ["Signal items", "off/view/edit"],
      ["It can also see", "off/view"],
    ]);
    const also = rows[3]!;
    expect(also.key).toBe(ALSO_SEE);
    expect(also.members.map((r) => [r.label, r.levels.join("/")])).toEqual([
      ["Pillars", "off/view"],
      ["Journey stages", "off/view"],
      ["Series", "off/view"],
      ["Platforms", "off/view"],
      ["Content compositions", "off/view"],
      ["Content assets", "off/view"],
      ["Inspirations", "off/view"],
      ["Documents", "off/view"],
      ["Links", "off/view"],
      ["Sessions", "off/view"],
      ["Changes waiting for your review", "off/view"],
    ]);
    // Every permission sits in exactly one top-level row; the folded row's
    // are exactly its members'.
    expect(
      rows.flatMap((r) => r.permissions.map((p) => p.permission)).sort()
    ).toEqual([...STUDIO_ASK].sort());
    expect(also.permissions).toEqual(
      also.members.flatMap((m) => m.permissions)
    );
  });

  it("every gate verb is a decision in ONE last row, On or Off; Edit is the other writes", () => {
    const gates = GRANT_GATE_ACTIONS.filter(
      (v) => v !== "approve" && v !== "reject"
    ).map((v) => `entity.post.${v}`);
    const offer: OfferedPermission[] = [
      { permission: "proposal.approve", workspaces: [CO] },
      { permission: "entity.post.read", workspaces: [CO] },
      { permission: "entity.post.update", workspaces: [CO] },
      ...gates.map((permission) => ({ permission, workspaces: [CO] })),
      { permission: "proposal.reject", workspaces: [CO] },
    ];
    const rows = groupByObject(offer);
    expect(rows.map((r) => [r.key, r.levels.join("/")])).toEqual([
      ["entity.post", "off/view/edit"],
      ["decisions", "off/on"],
    ]);
    expect(rows[1]!.label).toBe("Decide for you");
    expect(rows[1]!.permissions.map((p) => p.permission)).toEqual([
      "proposal.approve",
      ...gates,
      "proposal.reject",
    ]);
    for (const v of GRANT_GATE_ACTIONS) {
      expect(isDecisionPermission(`entity.post.${v}`), v).toBe(true);
    }
  });

  it("no gate verb starts ticked on a first consent, nor comes with Edit", () => {
    expect(PRESELECT_DECISIONS).toBe(false);
    const offer: OfferedPermission[] = [
      { permission: "entity.post.read", workspaces: ALL4 },
      { permission: "entity.post.update", workspaces: ALL4 },
      ...GRANT_GATE_ACTIONS.map((v) => ({
        permission: `entity.post.${v}`,
        workspaces: ALL4,
      })),
      { permission: "proposal.approve", workspaces: ALL4 },
      { permission: "entity.merge", workspaces: ALL4 },
    ];
    const gate = (a: { permission: string }) =>
      (GRANT_GATE_ACTIONS as readonly string[]).includes(
        a.permission.split(".").pop()!
      );
    const first = initialSelection(offer, [], TEMPLATES);
    expect(toApproved(first, offer).filter(gate)).toEqual([]);
    expect(toApproved(first, offer).map((a) => a.permission)).toEqual([
      "entity.post.read",
      "entity.post.read",
      "entity.post.update",
      "entity.post.update",
    ]);
    const posts = row(offer, "entity.post");
    const edit = setObjectLevel(
      setObjectLevel(first, offer, posts, "off", TEMPLATES),
      offer,
      posts,
      "edit",
      TEMPLATES
    );
    expect(toApproved(edit, offer).filter(gate)).toEqual([]);
  });

  it("the decide row names each gate verb it asks, in words", () => {
    const decide = (perms: string[]) =>
      row(
        perms.map((permission) => ({ permission, workspaces: [CO] })),
        "decisions"
      );
    expect(decideLine(decide(["proposal.approve", "proposal.reject"]))).toBe(
      "Approve or reject a change waiting for your review, as you"
    );
    expect(
      decideLine(
        decide(["proposal.approve", "entity.post.archive", "entity.merge"])
      )
    ).toBe("Approve, archive or merge, as you");
    expect(permissionLabel("entity.post.archive")).toBe("Archive posts");
    expect(permissionLabel("entity.merge")).toBe("Merge everything in it");
  });

  it("a row the app may only write offers Edit and Off, never View", () => {
    const r = row(
      [{ permission: "entity.file.create", workspaces: [CO] }],
      "entity.file"
    );
    expect(r.levels).toEqual(["off", "edit"]);
  });

  it("`entity.read` is Everything; a bare kind is a write", () => {
    const rows = groupByObject([
      { permission: "entity.read", workspaces: [CO] },
      { permission: "entity.note", workspaces: [CO] },
    ]);
    expect(rows.map((r) => [r.label, r.levels.join("/")])).toEqual([
      ["Notes", "off/edit"],
      ["It can also see", "off/view"],
    ]);
    expect(rows[1]!.members.map((r) => r.label)).toEqual(["Everything"]);
  });
});

describe('what it only views folds into ONE row, "It can also see"', () => {
  const offer: OfferedPermission[] = [
    { permission: "proposal.approve", workspaces: ALL4 },
    { permission: "entity.pillar.read", workspaces: ALL4 },
    { permission: "entity.post.read", workspaces: ALL4 },
    { permission: "entity.post.create", workspaces: [CO] },
    { permission: "document.read", workspaces: [CO, BRAND_S] },
    { permission: "entity.file.create", workspaces: ALL4 },
  ];
  const key = (a: { permission: string; workspaceId: string }) =>
    `${a.permission}@${a.workspaceId}`;

  it("an object it may write keeps its own row; one it only reads is folded; order edits, also-see, decide", () => {
    const rows = groupByObject(offer);
    expect(rows.map((r) => r.key)).toEqual([
      "entity.post",
      "entity.file",
      ALSO_SEE,
      "decisions",
    ]);
    expect(rows[2]!.members.map((m) => m.key)).toEqual([
      "entity.pillar",
      "document",
    ]);
    // A written object is never folded, even when it also reads.
    for (const r of rows) {
      for (const m of r.members) expect(m.levels).toEqual(["off", "view"]);
    }
  });

  it("names its objects inline: the first four, then +N more; Off names what it asks", () => {
    const s = initialSelection(STUDIO, [], TEMPLATES);
    const also = row(STUDIO, ALSO_SEE);
    expect(alsoSeeLine(s, also)).toBe(
      "Pillars, Journey stages, Series, Platforms +7 more"
    );
    const t = setObjectLevel(
      s,
      STUDIO,
      row(STUDIO, "entity.pillar"),
      "off",
      TEMPLATES
    );
    expect(alsoSeeLine(t, also)).toBe(
      "Journey stages, Series, Platforms, Content compositions +6 more"
    );
    const off = setObjectLevel(s, STUDIO, also, "off", TEMPLATES);
    expect(alsoSeeLine(off, also)).toBe(alsoSeeLine(s, also));
  });

  it("switching one folded object off removes exactly its pairs; the row stays View", () => {
    const s = initialSelection(offer, [], TEMPLATES);
    const also = row(offer, ALSO_SEE);
    const docs = row(offer, "document");
    const t = setObjectLevel(s, offer, docs, "off", TEMPLATES);
    expect(toApproved(t, offer).map(key)).toEqual(
      toApproved(s, offer)
        .filter((a) => a.permission !== "document.read")
        .map(key)
    );
    expect(objectLevel(t, docs)).toBe("off");
    expect(objectLevel(t, row(offer, "entity.pillar"))).toBe("view");
    expect(objectLevel(t, also)).toBe("view");
  });

  it("the folded row Off clears its objects only; View from Off gives each its reads in its default spaces", () => {
    const s = initialSelection(offer, [], TEMPLATES);
    const also = row(offer, ALSO_SEE);
    const off = setObjectLevel(s, offer, also, "off", TEMPLATES);
    expect(objectLevel(off, also)).toBe("off");
    expect(toApproved(off, offer).map(key)).toEqual(
      toApproved(s, offer)
        .filter(
          (a) =>
            a.permission !== "document.read" &&
            a.permission !== "entity.pillar.read"
        )
        .map(key)
    );
    const back = setObjectLevel(off, offer, also, "view", TEMPLATES);
    expect(toApproved(back, offer).map(key)).toEqual(
      toApproved(s, offer).map(key)
    );
  });

  it("never a pair outside the offer, from the folded row or one of its objects", () => {
    const today: OfferedPermission[] = [
      { permission: "entity.pillar.read", workspaces: [CO] },
      { permission: "document.read", workspaces: [] },
    ];
    const also = row(offer, ALSO_SEE); // an older, wider offer's row
    let s: Selection = new Set();
    s = setObjectLevel(s, today, also, "view", TEMPLATES);
    s = toggleObjectSpace(s, today, row(offer, "document"), "brand");
    s = toggleObjectSpace(s, today, row(offer, "entity.pillar"), "eco");
    s = setObjectLevel(s, today, row(offer, "entity.pillar"), "view", []);
    expect([...s]).toEqual(["entity.pillar.read\u0000co"]);
  });
});

describe("default spaces come from the app's declared templates", () => {
  it("the offered spaces made from a declared template", () => {
    expect(ids(defaultSpaces(STUDIO[0]!, TEMPLATES))).toEqual(["co", "eco"]);
  });

  it("no template declared: every offered space (#133)", () => {
    expect(ids(defaultSpaces(STUDIO[0]!, []))).toEqual(ids(ALL4));
  });

  it("no space from its templates for this permission: every offered space", () => {
    const item = {
      permission: "entity.post.create",
      workspaces: [BRAND_S, BUILDER],
    };
    expect(ids(defaultSpaces(item, TEMPLATES))).toEqual(["brand", "builder"]);
  });

  it("a first consent ticks each permission in its default spaces only", () => {
    const s = initialSelection(STUDIO, [], TEMPLATES);
    const approved = toApproved(s, STUDIO);
    expect(approved).toHaveLength(STUDIO_ASK.length * 2);
    expect(new Set(approved.map((a) => a.workspaceId))).toEqual(
      new Set(["co", "eco"])
    );
  });

  it("a re-consent ignores the templates: exactly the current approval", () => {
    const current = [{ permission: "entity.post.read", workspaceId: "brand" }];
    expect(
      toApproved(initialSelection(STUDIO, current, TEMPLATES), STUDIO)
    ).toEqual(current);
  });
});

describe("a row's level, both ways", () => {
  const posts = () => row(STUDIO, "entity.post");

  it("reads the level from the selection: Edit, View, Off", () => {
    const s = initialSelection(STUDIO, [], TEMPLATES);
    expect(objectLevel(s, posts())).toBe("edit");
    expect(objectLevel(s, row(STUDIO, "entity.pillar"))).toBe("view");
    let t = toggle(s, STUDIO, "entity.post.create", "co");
    t = toggle(t, STUDIO, "entity.post.create", "eco");
    t = toggle(t, STUDIO, "entity.post.update", "co");
    expect(objectLevel(t, posts())).toBe("edit");
    t = toggle(t, STUDIO, "entity.post.update", "eco");
    expect(objectLevel(t, posts())).toBe("view");
    t = toggle(t, STUDIO, "entity.post.read", "co");
    t = toggle(t, STUDIO, "entity.post.read", "eco");
    expect(objectLevel(t, posts())).toBe("off");
  });

  it("View keeps the row's spaces and gives its reads only", () => {
    const s = initialSelection(STUDIO, [], TEMPLATES);
    const v = setObjectLevel(s, STUDIO, posts(), "view", TEMPLATES);
    expect(objectLevel(v, posts())).toBe("view");
    expect(
      toApproved(v, STUDIO).filter((a) =>
        a.permission.startsWith("entity.post.")
      )
    ).toEqual([
      { permission: "entity.post.read", workspaceId: "co" },
      { permission: "entity.post.read", workspaceId: "eco" },
    ]);
  });

  it("Off clears exactly this row's pairs, nothing else", () => {
    const s = initialSelection(STUDIO, [], TEMPLATES);
    const off = setObjectLevel(s, STUDIO, posts(), "off", TEMPLATES);
    expect(objectLevel(off, posts())).toBe("off");
    const left = toApproved(off, STUDIO);
    expect(left.some((a) => a.permission.startsWith("entity.post."))).toBe(
      false
    );
    expect(left).toEqual(
      toApproved(s, STUDIO).filter(
        (a) => !a.permission.startsWith("entity.post.")
      )
    );
  });

  it("from Off, Edit gives every permission in its default spaces", () => {
    const off = setObjectLevel(
      initialSelection(STUDIO, [], TEMPLATES),
      STUDIO,
      posts(),
      "off",
      TEMPLATES
    );
    const e = setObjectLevel(off, STUDIO, posts(), "edit", TEMPLATES);
    expect(ids(objectSpaces(e, posts()))).toEqual(["co", "eco"]);
    expect(
      toApproved(e, STUDIO).filter((a) =>
        a.permission.startsWith("entity.post.")
      )
    ).toHaveLength(6);
  });

  it("a space added by the person survives a level change", () => {
    let s = initialSelection(STUDIO, [], TEMPLATES);
    s = toggleObjectSpace(s, STUDIO, posts(), "brand");
    // From Edit, a new space gets Edit there.
    expect(isTicked(s, "entity.post.create", "brand")).toBe(true);
    s = setObjectLevel(s, STUDIO, posts(), "view", TEMPLATES);
    expect(ids(objectSpaces(s, posts()))).toEqual(["brand", "co", "eco"]);
    expect(isTicked(s, "entity.post.create", "brand")).toBe(false);
  });

  it("a space untick clears that space only; from Off a tick gives the lowest level", () => {
    let s = initialSelection(STUDIO, [], TEMPLATES);
    s = toggleObjectSpace(s, STUDIO, posts(), "co");
    expect(ids(objectSpaces(s, posts()))).toEqual(["eco"]);
    const off = setObjectLevel(s, STUDIO, posts(), "off", TEMPLATES);
    const t = toggleObjectSpace(off, STUDIO, posts(), "builder");
    expect(objectLevel(t, posts())).toBe("view");
    expect(ids(objectSpaces(t, posts()))).toEqual(["builder"]);
  });

  it("decisions: On gives approve and reject in the default spaces, Off by default", () => {
    const offer: OfferedPermission[] = [
      { permission: "entity.post.read", workspaces: ALL4 },
      { permission: "proposal.approve", workspaces: ALL4 },
      { permission: "proposal.reject", workspaces: [CO] },
    ];
    const decide = row(offer, "decisions");
    const s = initialSelection(offer, [], TEMPLATES);
    expect(objectLevel(s, decide)).toBe("off");
    const on = setObjectLevel(s, offer, decide, "on", TEMPLATES);
    expect(objectLevel(on, decide)).toBe("on");
    expect(
      toApproved(on, offer).filter((a) => a.permission.startsWith("proposal."))
    ).toEqual([
      { permission: "proposal.approve", workspaceId: "co" },
      { permission: "proposal.approve", workspaceId: "eco" },
      { permission: "proposal.reject", workspaceId: "co" },
    ]);
  });
});

describe("rows and Customize share ONE selection, inside the offer", () => {
  it("a tick in the matrix moves the row's level; a row's level moves the matrix", () => {
    const posts = row(STUDIO, "entity.post");
    let s = setObjectLevel(
      initialSelection(STUDIO, [], TEMPLATES),
      STUDIO,
      posts,
      "view",
      TEMPLATES
    );
    expect(isTicked(s, "entity.post.create", "co")).toBe(false);
    s = toggle(s, STUDIO, "entity.post.create", "co");
    expect(objectLevel(s, posts)).toBe("edit");
    const { grants } = splitOffer(STUDIO);
    s = toggleSection(s, STUDIO, grants); // some → all
    s = toggleSection(s, STUDIO, grants); // all → none
    expect(objectLevel(s, posts)).toBe("off");
  });

  it("never a pair outside the offer, whatever the level or space", () => {
    const narrow: OfferedPermission[] = [
      { permission: "entity.post.read", workspaces: [CO, BRAND_S] },
      { permission: "entity.post.create", workspaces: [CO] },
    ];
    const posts = row(narrow, "entity.post");
    let s: Selection = new Set();
    s = setObjectLevel(s, narrow, posts, "edit", TEMPLATES);
    s = toggleObjectSpace(s, narrow, posts, "brand");
    s = toggleObjectSpace(s, narrow, posts, "elsewhere");
    s = setObjectLevel(s, narrow, posts, "edit", TEMPLATES);
    const offered = new Set(
      narrow.flatMap((o) =>
        o.workspaces.map((w) => `${o.permission}\u0000${w.workspaceId}`)
      )
    );
    for (const k of s) expect(offered.has(k), k).toBe(true);
    expect(toApproved(s, narrow)).toEqual([
      { permission: "entity.post.read", workspaceId: "co" },
      { permission: "entity.post.read", workspaceId: "brand" },
      { permission: "entity.post.create", workspaceId: "co" },
    ]);
  });
});

describe("a row from an older offer never widens today's", () => {
  // The rows are derived from the offer of one render; the offer can be
  // re-read under them (a space created from this screen re-fetches it).
  const wide: OfferedPermission[] = [
    { permission: "entity.post.read", workspaces: [CO, ECO, BRAND_S] },
    { permission: "entity.post.create", workspaces: [CO, ECO] },
  ];
  const today: OfferedPermission[] = [
    { permission: "entity.post.read", workspaces: [CO] },
    { permission: "entity.post.create", workspaces: [CO] },
  ];
  const stale = () => row(wide, "entity.post");

  it("a level from Off, or over held spaces, gives only what today's offer holds", () => {
    const fromOff = setObjectLevel(new Set(), today, stale(), "edit", []);
    expect(toApproved(fromOff, today)).toHaveLength(2);
    expect(fromOff.size).toBe(2);
    const held = new Set([
      "entity.post.read\u0000co",
      "entity.post.read\u0000eco",
    ]);
    const kept = setObjectLevel(held, today, stale(), "edit", []);
    expect([...kept].sort()).toEqual([
      "entity.post.create\u0000co",
      "entity.post.read\u0000co",
    ]);
  });

  it("a space tick gives only what today's offer holds", () => {
    const s = toggleObjectSpace(new Set(), today, stale(), "brand");
    expect(s.size).toBe(0);
  });
});

describe("where a row is given", () => {
  it("shows its own and default spaces; the rest wait behind the disclosure", () => {
    const posts = row(STUDIO, "entity.post");
    const s = initialSelection(STUDIO, [], TEMPLATES);
    expect(ids(shownSpaces(s, posts, TEMPLATES))).toEqual(["co", "eco"]);
    expect(ids(otherSpaces(s, posts, TEMPLATES))).toEqual(["brand", "builder"]);
    // No template: every space shows, nothing waits.
    expect(otherSpaces(initialSelection(STUDIO, []), posts, [])).toEqual([]);
  });

  it("in words, from the spaces it holds", () => {
    expect(scopeLabel([])).toBeNull();
    expect(scopeLabel([CO])).toBe("in Content OS");
    expect(scopeLabel([CO, ECO])).toBe("in Content OS and Ecosystem");
    expect(scopeLabel([BRAND_S, CO, ECO])).toBe(
      "in Brand, Content OS and Ecosystem"
    );
    expect(
      scopeLabel([...ALL4, { workspaceId: "x", workspaceName: "X" }])
    ).toBe("in Brand, Builder and 3 more spaces");
  });

  it("a pod-wide kind's note says it reaches the app only through a role in a given space", () => {
    expect(
      podWideNote(
        row(
          [{ permission: "entity.person.read", workspaces: [CO] }],
          "entity.person"
        )
      )
    ).toBe(
      "People kept across your whole pod, not in one space, reach it only through a role in a space you give it."
    );
  });
});

describe("an app asks for anything an agent key may hold (apps = agents)", () => {
  const ASK: OfferedPermission[] = [
    "entity.deal.read",
    "entity.deal.update",
    "tool.create",
    "playbook.run",
    "capability.run",
    "entity.deal.transition",
    "proposal.approve",
    "*",
  ].map((permission) => ({ permission, workspaces: [CO] }));

  it("every named verb beyond read/create/update/delete is a decision; so is *", () => {
    for (const p of [
      "playbook.run",
      "capability.run",
      "tool.bind",
      "entity.deal.transition",
      "*",
    ]) {
      expect(isDecisionPermission(p), p).toBe(true);
    }
    for (const p of ["tool.create", "entity.*", "entity.post", "document"]) {
      expect(isDecisionPermission(p), p).toBe(false);
    }
  });

  it("full access is its own row, first, named as what it is; run and move are decisions", () => {
    const rows = groupByObject(ASK, "agent");
    expect(rows.map((r) => [r.key, r.label, r.levels.join("/")])).toEqual([
      [FULL_ACCESS, FULL_ACCESS_LABEL, "off/on"],
      ["entity.deal", "Deals", "off/view/edit"],
      ["tool", "Tools", "off/edit"],
      ["decisions", "Act, after your review", "off/on"],
    ]);
    expect(rows[3]!.permissions.map((p) => p.permission)).toEqual([
      "playbook.run",
      "capability.run",
      "entity.deal.transition",
      "proposal.approve",
    ]);
  });

  it("a first consent ticks neither full access nor a decision", () => {
    expect(
      toApproved(initialSelection(ASK, [], TEMPLATES), ASK).map(
        (a) => a.permission
      )
    ).toEqual(["entity.deal.read", "entity.deal.update", "tool.create"]);
  });

  it("an app acting as its own agent: each act goes to review, it never approves", () => {
    const rows = groupByObject(ASK, "agent");
    const decide = rows.find((r) => r.key === "decisions")!;
    expect(decideLine(decide, "agent")).toBe(
      "Run or move, each sent to you for review first. It never approves or rejects for you"
    );
    expect(decideLine(rows[0]!, "agent")).toBe(
      "Everything you can do in these spaces, each change sent to you for review first. It never approves or rejects for you"
    );
    expect(decisionsHeading("agent")).toBe("It asks to act, after your review");
    expect(levelControlLabel(decide, "agent")).toBe(
      "Let it ask to act, after your review"
    );
    expect(levelControlLabel(rows[0]!, "agent")).toBe(FULL_ACCESS_LABEL);
    // Only review verbs asked: said as what they are.
    const review = groupByObject(
      [{ permission: "proposal.approve", workspaces: [CO] }],
      "agent"
    ).find((r) => r.key === "decisions")!;
    expect(decideLine(review, "agent")).toBe(
      "It never approves or rejects for you"
    );
  });

  it("a Synap app decides as the person", () => {
    const rows = groupByObject(ASK, "person");
    const decide = rows.find((r) => r.key === "decisions")!;
    expect(decide.label).toBe("Decide for you");
    expect(decideLine(decide, "person")).toBe("Run, move or approve, as you");
    expect(decideLine(rows[0]!, "person")).toBe(
      "Everything you can do in these spaces, approving included, as you"
    );
    expect(decisionsHeading("person")).toBe("It asks to decide for you");
    expect(levelControlLabel(decide, "person")).toBe("Let it decide for you");
  });

  it("full access On gives * alone; Off clears it", () => {
    const full = groupByObject(ASK, "agent")[0]!;
    const on = setObjectLevel(new Set(), ASK, full, "on", TEMPLATES);
    expect(toApproved(on, ASK)).toEqual([
      { permission: "*", workspaceId: "co" },
    ]);
    expect(
      toApproved(setObjectLevel(on, ASK, full, "off", TEMPLATES), ASK)
    ).toEqual([]);
  });
});

// ─── A re-consent names what is new (founder, 2026-10-27) ────────────────────

describe("a re-consent names what it asks that is new", () => {
  /** The CRM's spaces: one from its declared template, one not. */
  const CRM_S = {
    workspaceId: "crm",
    workspaceName: "CRM",
    templateSlug: "crm",
  };
  const CRM_TEMPLATES = ["crm"];
  /**
   * crm.synap.live's re-consent of 2026-10-26: four asks added (person and
   * company edits, reading and running a process) to what the person had
   * allowed. `proposal.read` they had allowed in Brand only.
   */
  const CRM_ASK = [
    "entity.person.read",
    "entity.person.update",
    "entity.company.read",
    "entity.company.update",
    "proposal.read",
    "playbook.read",
    "playbook.run",
  ];
  const CRM: OfferedPermission[] = CRM_ASK.map((permission) => ({
    permission,
    workspaces: [BRAND_S, CRM_S],
  }));
  const CURRENT = [
    { permission: "entity.person.read", workspaceId: "crm" },
    { permission: "entity.company.read", workspaceId: "crm" },
    { permission: "proposal.read", workspaceId: "brand" },
  ];
  const asks = () => newAsks(CRM, CURRENT, CRM_TEMPLATES);

  it("lists each permission the approval holds in no space, in its default spaces", () => {
    expect(asks().map((o) => [o.permission, ids(o.workspaces)])).toEqual([
      ["entity.person.update", ["crm"]],
      ["entity.company.update", ["crm"]],
      ["playbook.read", ["crm"]],
      ["playbook.run", ["crm"]],
    ]);
  });

  it("a permission allowed in another space is not new", () => {
    // Allowed in Brand, not in CRM: a narrowing the person chose, not news.
    expect(asks().map((o) => o.permission)).not.toContain("proposal.read");
  });

  it("a first consent has none; the same ask again has none", () => {
    expect(newAsks(CRM, [], CRM_TEMPLATES)).toEqual([]);
    const all = CRM_ASK.map((permission) => ({
      permission,
      workspaceId: "crm",
    }));
    expect(newAsks(CRM, all, CRM_TEMPLATES)).toEqual([]);
  });

  it("a new decision is listed, and still starts unticked", () => {
    const run = asks().find((o) => o.permission === "playbook.run");
    expect(run).toBeDefined();
    expect(isDecisionPermission("playbook.run")).toBe(true);
    const s = initialSelection(CRM, CURRENT, CRM_TEMPLATES);
    expect(isTicked(s, "playbook.run", "crm")).toBe(false);
  });

  it("a new ask with no space to give is left out (nothing to tick)", () => {
    const offer = [...CRM, { permission: "document.read", workspaces: [] }];
    expect(
      newAsks(offer, CURRENT, CRM_TEMPLATES).map((o) => o.permission)
    ).not.toContain("document.read");
  });

  it("the switch starts Off: the selection is exactly the current approval", () => {
    const s = initialSelection(CRM, CURRENT, CRM_TEMPLATES);
    expect(newAsksAllowed(s, asks())).toBe(false);
    expect(toApproved(s, CRM)).toEqual(CURRENT);
  });

  it("On: the selection gains exactly the new pairs, and the rows follow", () => {
    const before = initialSelection(CRM, CURRENT, CRM_TEMPLATES);
    const after = allowNewAsks(before, CRM, asks(), true);
    const k = (a: { permission: string; workspaceId: string }) =>
      `${a.permission}@${a.workspaceId}`;
    const was = new Set(toApproved(before, CRM).map(k));
    expect(
      toApproved(after, CRM)
        .map(k)
        .filter((x) => !was.has(x))
    ).toEqual([
      "entity.person.update@crm",
      "entity.company.update@crm",
      "playbook.read@crm",
      "playbook.run@crm",
    ]);
    // Nothing it held is lost.
    for (const x of was) expect(toApproved(after, CRM).map(k)).toContain(x);
    expect(newAsksAllowed(after, asks())).toBe(true);
    // The ONE selection: People and Companies were View, now Edit; the
    // decision row is On.
    expect(objectLevel(before, row(CRM, "entity.person"))).toBe("view");
    expect(objectLevel(after, row(CRM, "entity.person"))).toBe("edit");
    expect(objectLevel(after, row(CRM, "entity.company"))).toBe("edit");
    expect(objectLevel(after, row(CRM, "decisions"))).toBe("on");
  });

  it("Off leaves the selection unchanged; On then Off returns to it", () => {
    const before = initialSelection(CRM, CURRENT, CRM_TEMPLATES);
    expect(allowNewAsks(before, CRM, asks(), false)).toEqual(before);
    const on = allowNewAsks(before, CRM, asks(), true);
    expect(allowNewAsks(on, CRM, asks(), false)).toEqual(before);
  });

  it("one new pair unticked in a row: the switch reads Off, pressing it ticks them all", () => {
    const on = allowNewAsks(
      initialSelection(CRM, CURRENT, CRM_TEMPLATES),
      CRM,
      asks(),
      true
    );
    const one = toggle(on, CRM, "playbook.run", "crm");
    expect(newAsksAllowed(one, asks())).toBe(false);
    expect(allowNewAsks(one, CRM, asks(), true)).toEqual(on);
  });

  it("never a pair outside today's offer, from asks of an older offer", () => {
    const stale: OfferedPermission[] = [
      { permission: "entity.deal.update", workspaces: [CRM_S] },
    ];
    const s = allowNewAsks(new Set(), CRM, stale, true);
    expect(s.size).toBe(0);
  });
});

// A role on a record (#411): the app is granted `facet.create` /
// `facet.delete`; `facet.attach` / `facet.detach` are the door's spelling of
// the same act and get the same treatment, never a decision row.
describe("adding and removing roles on records", () => {
  const ROLES: OfferedPermission[] = [
    "facet.read",
    "facet.create",
    "facet.attach",
    "facet.update",
    "facet.delete",
    "facet.detach",
  ].map((permission) => ({ permission, workspaces: [CO] }));

  it.each([
    ["facet.create", "Add roles to records"],
    ["facet.attach", "Add roles to records"],
    ["facet.delete", "Remove roles from records"],
    ["facet.detach", "Remove roles from records"],
    ["facet.update", "Edit roles"],
    ["facet.read", "Read roles"],
  ])("%s → %s", (permission, label) => {
    expect(permissionLabel(permission)).toBe(label);
  });

  it("attach and detach are writes, as create and delete are, never a decision", () => {
    for (const p of ROLES.map((o) => o.permission)) {
      expect(isDecisionPermission(p), p).toBe(false);
    }
    expect(splitOffer(ROLES).decisions).toEqual([]);
  });

  it("every spelling sits in ONE Roles row, at Edit", () => {
    const rows = groupByObject(ROLES, "agent");
    expect(rows.map((r) => [r.key, r.label, r.levels.join("/")])).toEqual([
      ["facet", "Roles", "off/view/edit"],
    ]);
    expect(rows[0]!.permissions).toHaveLength(ROLES.length);
  });

  it("first consent ticks attach and detach as it ticks create and delete", () => {
    const approved = toApproved(initialSelection(ROLES, []), ROLES);
    expect(approved.map((a) => a.permission)).toEqual(
      ROLES.map((o) => o.permission)
    );
  });
});
