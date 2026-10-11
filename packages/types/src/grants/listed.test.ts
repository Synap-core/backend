/**
 * grantToDraft / draftToGrantInput — a listed grant round-trips into the
 * write door without losing its role lineage.
 */
import { describe, expect, it } from "vitest";
import {
  FULL_ACCESS_ACCESSIBLE_NAME,
  FULL_ACCESS_LABEL,
  draftToGrantInput,
  grantToDraft,
} from "./index.js";

describe("grantToDraft", () => {
  // Rules out: the local `draftOf` copies that dropped `roleId`, so saving one
  // grant of several silently cut the others' lineage.
  it("keeps roleId, label and narrowing; carries no lifetime", () => {
    const d = grantToDraft({
      permissions: ["entity.note.read"],
      workspaceIds: ["ws"],
      projectIds: null,
      entityIds: null,
      label: "Notes",
      roleId: "role-1",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(d).toEqual({
      permissions: ["entity.note.read"],
      workspaceIds: ["ws"],
      projectIds: undefined,
      entityIds: undefined,
      label: "Notes",
      roleId: "role-1",
    });
    expect(draftToGrantInput(d)).toEqual({
      permissions: ["entity.note.read"],
      workspaceIds: ["ws"],
      label: "Notes",
      roleId: "role-1",
    });
  });

  it("a grant with no role sends none", () => {
    const d = grantToDraft({ permissions: ["*"], expiresAt: null });
    expect("roleId" in d).toBe(false);
    expect(draftToGrantInput(d)).toEqual({ permissions: ["*"] });
  });
});

describe("FULL_ACCESS_LABEL", () => {
  it("the chip says Full access; its accessible name says approving", () => {
    expect(FULL_ACCESS_LABEL).toBe("Full access");
    expect(FULL_ACCESS_ACCESSIBLE_NAME).toBe("Full access, approving included");
  });
});
