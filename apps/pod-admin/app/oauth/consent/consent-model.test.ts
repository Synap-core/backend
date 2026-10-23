import { describe, expect, it } from "vitest";

import {
  actsAsHeadline,
  allowBlockedReason,
  consentClientKind,
  consentWidth,
  initialSelection,
  invalidRequestHint,
  isTicked,
  permissionLabel,
  reasonOf,
  sectionCheckboxLabel,
  sectionState,
  spaceCheckboxLabel,
  splitOffer,
  toApproved,
  toggle,
  toggleSection,
  withoutSpace,
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
  ])("%s → %s", (permission, label) => {
    expect(permissionLabel(permission)).toBe(label);
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
      "Pick at least one space."
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
    expect(allowBlockedReason(OFFER, s)).toBe("Pick at least one space.");
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
