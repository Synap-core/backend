import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));
import { GRANT_PRESETS, type GrantRole } from "@synap-core/types/grants";
import { grantFromRole, NO_GRANT } from "./grant-role-picker";

const stored: GrantRole = {
  id: "8e2c1f0a-0000-4000-8000-000000000001",
  name: "Card site",
  description: "",
  stored: true,
  grant: { permissions: ["entity.person.create"] },
};

describe("grantFromRole", () => {
  it("a stored role carries its permissions AND its lineage", () => {
    expect(grantFromRole(stored.id, [...GRANT_PRESETS, stored])).toEqual({
      permissions: ["entity.person.create"],
      roleId: stored.id,
    });
  });
  it("a preset carries its permissions, never a roleId (the pod would refuse a non-own role)", () => {
    const g = grantFromRole(GRANT_PRESETS[0].id, [...GRANT_PRESETS, stored]);
    expect(g?.permissions).toEqual([...GRANT_PRESETS[0].grant.permissions]);
    expect(g).not.toHaveProperty("roleId");
  });
  it("'No grant' mints no grant", () => {
    expect(grantFromRole(NO_GRANT, [...GRANT_PRESETS, stored])).toBeUndefined();
  });
});
