import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));
import { GRANT_PRESETS, type GrantRole } from "@synap-core/types/grants";
import {
  keyMintFromRole,
  mintDraft,
  NO_GRANT,
  roleFitsWorkspace,
} from "./grant-role-picker";

const WS = "2aaaaaaa-0000-4000-8000-000000000001";
const WS_OTHER = "2bbbbbbb-0000-4000-8000-000000000002";
const PROJECT = "3aaaaaaa-0000-4000-8000-000000000001";

const stored: GrantRole = {
  id: "8e2c1f0a-0000-4000-8000-000000000001",
  name: "Card site",
  description: "",
  stored: true,
  grant: {
    permissions: ["entity.person.create"],
    workspaceIds: [WS],
    projectIds: [PROJECT],
    expiresInDays: 30,
  },
};
const roles = [...GRANT_PRESETS, stored];
const dialog = { expiresInDays: 365 };

describe("keyMintFromRole", () => {
  it("a stored role mints its permissions, narrowing, lifetime AND lineage", () => {
    expect(keyMintFromRole(stored.id, roles, dialog)).toEqual({
      grant: {
        permissions: ["entity.person.create"],
        workspaceIds: [WS],
        projectIds: [PROJECT],
        roleId: stored.id,
      },
      expiresInDays: 30,
    });
  });

  it("a preset carries no roleId, and the dialog's lifetime when it sets none", () => {
    const m = keyMintFromRole(GRANT_PRESETS[0].id, roles, dialog);
    expect(new Set(m?.grant.permissions)).toEqual(
      new Set(GRANT_PRESETS[0].grant.permissions)
    );
    expect(m?.grant).not.toHaveProperty("roleId");
    expect(m?.expiresInDays).toBe(365);
    expect(
      keyMintFromRole(GRANT_PRESETS[0].id, roles, { expiresInDays: null })
        ?.expiresInDays
    ).toBeNull();
  });

  it("a workspace's key is confined to that workspace", () => {
    const m = keyMintFromRole(GRANT_PRESETS[2].id, roles, {
      ...dialog,
      workspaceId: WS,
    });
    expect(m?.grant).toMatchObject({ permissions: ["*"], workspaceIds: [WS] });
    expect(mintDraft(m!).workspaceIds).toEqual([WS]);
  });

  it("refuses to re-confine a role made for other workspaces", () => {
    expect(roleFitsWorkspace(stored, WS_OTHER)).toBe(false);
    expect(roleFitsWorkspace(GRANT_PRESETS[0], WS_OTHER)).toBe(true);
    expect(() =>
      keyMintFromRole(stored.id, roles, { ...dialog, workspaceId: WS_OTHER })
    ).toThrow();
  });

  it("'No grant' mints no grant", () => {
    expect(keyMintFromRole(NO_GRANT, roles, dialog)).toBeUndefined();
  });
});
