import { describe, expect, it } from "vitest";

import {
  allowBlockedReason,
  consentClientKind,
  initialSelection,
  invalidRequestHint,
  isTicked,
  permissionLabel,
  reasonOf,
  spaceCheckboxLabel,
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
  ])("%s → %s", (permission, label) => {
    expect(permissionLabel(permission)).toBe(label);
  });
});

describe("consent space hint (preselect only)", () => {
  it("a hint naming an offered space pre-ticks it where the person picks", () => {
    const s = initialSelection(OFFER, [], "shared");
    expect(isTicked(s, "entity.post.read", "shared")).toBe(true);
    expect(isTicked(s, "entity.post.read", "brand")).toBe(false);
    // A permission not offered in the hinted space keeps the one-space rule.
    expect(isTicked(s, "entity.post.create", "brand")).toBe(true);
  });

  it("a hint the person cannot grant there is ignored", () => {
    const s = initialSelection(OFFER, [], "someone-elses-space");
    expect(toApproved(s, OFFER)).toEqual([
      { permission: "entity.post.create", workspaceId: "brand" },
    ]);
  });

  it("a re-consent keeps the current approval; the hint never adds to it", () => {
    const s = initialSelection(
      OFFER,
      [{ permission: "entity.post.read", workspaceId: "brand" }],
      "shared"
    );
    expect(toApproved(s, OFFER)).toEqual([
      { permission: "entity.post.read", workspaceId: "brand" },
    ]);
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
    const s = initialSelection(OFFER, []);
    expect(allowBlockedReason(OFFER, s)).toBeNull();
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
  it.each([
    ["https://studio.example.com/synap/client.json", "pod_app"],
    ["app_1a2b3c", "sign_in"],
    ["3f2c9a10-dcr-client", "mcp"],
  ] as const)("%s is %s", (clientId, kind) => {
    expect(consentClientKind(clientId)).toBe(kind);
  });

  it("a pod app or a sign-in is never told to go back to Claude", () => {
    expect(invalidRequestHint("pod_app")).not.toMatch(/claude/i);
    expect(invalidRequestHint("pod_app")).toMatch(/website/);
    expect(invalidRequestHint("sign_in")).not.toMatch(/claude/i);
  });

  it("an MCP client keeps the Claude wording", () => {
    expect(invalidRequestHint("mcp")).toMatch(/from Claude/);
  });

  it("no hint uses an em dash", () => {
    for (const k of ["pod_app", "sign_in", "mcp"] as const) {
      expect(invalidRequestHint(k)).not.toContain("\u2014");
    }
  });
});
