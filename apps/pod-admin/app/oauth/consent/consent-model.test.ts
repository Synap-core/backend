import { describe, expect, it } from "vitest";

import {
  actsAsHeadline,
  initialSelection,
  isTicked,
  permissionLabel,
  splitOffer,
  toApproved,
  toggle,
  withoutSpace,
  type OfferedPermission,
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
  it("first consent: a permission with one space starts ticked, several start unticked", () => {
    const s = initialSelection(OFFER, []);
    expect(toApproved(s, OFFER)).toEqual([
      { permission: "entity.post.create", workspaceId: "brand" },
    ]);
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

  it("unticking narrows; ticking an offered pair adds it", () => {
    let s = initialSelection(OFFER, []);
    s = toggle(s, OFFER, "entity.post.create", "brand");
    expect(toApproved(s, OFFER)).toEqual([]);
    s = toggle(s, OFFER, "entity.post.read", "shared");
    expect(isTicked(s, "entity.post.read", "shared")).toBe(true);
  });

  it("a pair the offer does not hold can never be ticked (no widening)", () => {
    let s = initialSelection(OFFER, []);
    s = toggle(s, OFFER, "entity.post.create", "shared");
    s = toggle(s, OFFER, "entity.post.delete", "brand");
    s = toggle(s, OFFER, "document.update", "brand");
    // Not even held in the screen's state (what the checkboxes render from).
    expect(isTicked(s, "entity.post.create", "shared")).toBe(false);
    expect(isTicked(s, "entity.post.delete", "brand")).toBe(false);
    expect(s.size).toBe(1);
    expect(toApproved(s, OFFER)).toEqual([
      { permission: "entity.post.create", workspaceId: "brand" },
    ]);
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
      "Content Studio will act as you in: Brand."
    );
    s = toggle(s, OFFER, "entity.post.read", "shared");
    s = toggle(s, OFFER, "entity.post.read", "brand");
    expect(actsAsHeadline(LEAD, s, OFFER)).toBe(
      "Content Studio will act as you in: Brand, Shared."
    );
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

  it("first consent: a write with one space starts ticked, a decision never does", () => {
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
