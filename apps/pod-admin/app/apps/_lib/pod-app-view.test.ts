import { describe, expect, it } from "vitest";
import {
  approvalBySpace,
  approvalSentence,
  keepWithout,
  podAppRevokeNote,
  POD_APP_ACCESS_LINE,
  tierLabel,
  writeModeConfirm,
  type PodAppPair,
} from "./pod-app-view";

const BRAND = "w-brand";
const SHARED = "w-shared";
const APPROVED: PodAppPair[] = [
  {
    permission: "entity.post.read",
    workspaceId: BRAND,
    workspaceName: "Brand",
  },
  {
    permission: "entity.post.create",
    workspaceId: BRAND,
    workspaceName: "Brand",
  },
  {
    permission: "entity.post.read",
    workspaceId: SHARED,
    workspaceName: "Shared",
  },
];

describe("a pod app's approval, as its page reads it", () => {
  it("groups the approval by space, in words", () => {
    expect(approvalBySpace(APPROVED)).toEqual([
      {
        workspaceId: BRAND,
        workspaceName: "Brand",
        permissions: [
          { permission: "entity.post.read", label: "Read posts" },
          { permission: "entity.post.create", label: "Create posts" },
        ],
      },
      {
        workspaceId: SHARED,
        workspaceName: "Shared",
        permissions: [{ permission: "entity.post.read", label: "Read posts" }],
      },
    ]);
    expect(approvalSentence(APPROVED)).toBe(
      "Read posts, Create posts in Brand · Read posts in Shared"
    );
  });

  it("names the tier", () => {
    expect(tierLabel(true)).toBe("Synap app");
    expect(tierLabel(false)).toBe("Unverified app");
  });
});

describe("narrow only takes away", () => {
  it("removing one permission in one space keeps everything else", () => {
    expect(
      keepWithout(APPROVED, {
        permission: "entity.post.create",
        workspaceId: BRAND,
      })
    ).toEqual([
      { permission: "entity.post.read", workspaceId: BRAND },
      { permission: "entity.post.read", workspaceId: SHARED },
    ]);
  });

  it("removing a space drops every permission there", () => {
    expect(keepWithout(APPROVED, { workspaceId: BRAND })).toEqual([
      { permission: "entity.post.read", workspaceId: SHARED },
    ]);
  });

  it("the last pair cannot be removed here (that is Revoke), and an unknown pair changes nothing", () => {
    expect(keepWithout([APPROVED[0]!], { workspaceId: BRAND })).toBeNull();
    expect(
      keepWithout(APPROVED, {
        permission: "entity.post.delete",
        workspaceId: BRAND,
      })
    ).toBeNull();
  });
});

describe("Apply automatically is confirmed before it turns on", () => {
  const verified = { domain: "studio.synap.live", verified: true };
  const unverified = { domain: "studio.example.com", verified: false };

  it("turning it off needs no confirm", () => {
    expect(writeModeConfirm(false, verified)).toBeNull();
    expect(writeModeConfirm(false, unverified)).toBeNull();
  });

  it("a Synap app: a confirm naming the domain and tier, no checkbox", () => {
    const c = writeModeConfirm(true, verified)!;
    expect(c).not.toBeNull();
    expect(c.title).toContain("studio.synap.live");
    expect(c.body.join(" ")).toContain("(Synap app)");
    expect(c.body.join(" ")).toMatch(/without your review/);
    expect(c.acknowledge).toBeNull();
    expect(c.color).toBe("warning");
  });

  it("an unverified app: a stronger confirm, with a checkbox to tick", () => {
    const c = writeModeConfirm(true, unverified)!;
    expect(c.color).toBe("danger");
    expect(c.body.join(" ")).toContain("(Unverified app)");
    expect(c.body.join(" ")).toMatch(/not checked/);
    expect(c.acknowledge).toContain("studio.example.com");
  });
});

describe("revoking a pod app here stops it everywhere", () => {
  it("says so, and says what the app's Disconnect does instead", () => {
    const note = podAppRevokeNote("studio.example.com");
    expect(note).toContain("studio.example.com");
    expect(note).toMatch(/everywhere/);
    expect(note).toMatch(/Disconnect/);
    expect(POD_APP_ACCESS_LINE).toMatch(/revoke the app/);
  });
});
