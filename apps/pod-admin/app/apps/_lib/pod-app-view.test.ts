import { describe, expect, it } from "vitest";
import {
  approvalBySpace,
  approvalSentence,
  keepWithout,
  tierLabel,
  type PodAppPair,
} from "./pod-app-view";

const BRAND = "w-brand";
const SHARED = "w-shared";
const APPROVED: PodAppPair[] = [
  { permission: "entity.post.read", workspaceId: BRAND, workspaceName: "Brand" },
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
      keepWithout(APPROVED, { permission: "entity.post.delete", workspaceId: BRAND })
    ).toBeNull();
  });
});
