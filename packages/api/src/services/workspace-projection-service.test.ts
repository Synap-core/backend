/**
 * Unit tests for the workspace public-projection write helper.
 *
 * Proves the two invariants the door depends on:
 *  1. NON-CLOBBERING MERGE — the helper hands `mergeSettings` a patch containing
 *     ONLY the `publicProjection` top-level key, so the canonical JSONB `||`
 *     preserves every other settings key (aiGovernance, sourceRoles, …).
 *  2. INPUT VALIDATION — `PublicProjectionInputSchema` rejects a missing
 *     `enabled`, an empty `roles` list, and defaults `fields` to `[]`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` so the capture spies exist before the hoisted vi.mock factory runs.
const { findFirstMock, mergeSettingsMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  mergeSettingsMock: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  db: { query: { workspaces: { findFirst: findFirstMock } } },
  getDb: vi.fn(async () => ({})),
  workspaces: { id: "w.id" },
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  eventRepository: {},
  WorkspaceRepository: class {
    mergeSettings = mergeSettingsMock;
  },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  PublicProjectionInputSchema,
  setWorkspacePublicProjection,
} from "./workspace-projection-service.js";

const WS = "11111111-1111-1111-1111-111111111111";

describe("PublicProjectionInputSchema", () => {
  it("accepts a valid config and defaults fields to []", () => {
    const parsed = PublicProjectionInputSchema.safeParse({
      enabled: true,
      roles: ["provider"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.fields).toEqual([]);
  });

  it("rejects a missing enabled flag", () => {
    expect(
      PublicProjectionInputSchema.safeParse({ roles: ["provider"] }).success
    ).toBe(false);
  });

  it("rejects an empty roles list (default-deny is via enabled:false)", () => {
    expect(
      PublicProjectionInputSchema.safeParse({ enabled: true, roles: [] }).success
    ).toBe(false);
  });

  it("rejects a blank role slug", () => {
    expect(
      PublicProjectionInputSchema.safeParse({ enabled: true, roles: [""] })
        .success
    ).toBe(false);
  });
});

describe("setWorkspacePublicProjection", () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    mergeSettingsMock.mockReset();
  });

  it("writes ONLY the publicProjection key — never clobbers other settings", async () => {
    // Existing settings carry unrelated keys that must survive the write.
    findFirstMock.mockResolvedValue({
      settings: {
        aiGovernance: { autoApproveFor: ["entity.create"] },
        sourceRoles: { comms: "provider" },
        theme: "dark",
      },
    });

    const result = await setWorkspacePublicProjection(
      WS,
      { enabled: true, roles: ["provider", "consumer"], fields: ["title"] },
      "user-1"
    );

    expect(mergeSettingsMock).toHaveBeenCalledTimes(1);
    const [wsId, patch, actor] = mergeSettingsMock.mock.calls[0];
    expect(wsId).toBe(WS);
    expect(actor).toBe("user-1");
    // The patch touches EXACTLY one top-level key — the JSONB `||` merge then
    // preserves aiGovernance / sourceRoles / theme untouched.
    expect(Object.keys(patch)).toEqual(["publicProjection"]);
    expect(patch.publicProjection).toEqual({
      enabled: true,
      roles: ["provider", "consumer"],
      fields: ["title"],
    });
    expect(result).toEqual({
      enabled: true,
      roles: ["provider", "consumer"],
      fields: ["title"],
    });
  });

  it("throws when the workspace does not exist", async () => {
    findFirstMock.mockResolvedValue(undefined);
    await expect(
      setWorkspacePublicProjection(
        WS,
        { enabled: true, roles: ["provider"], fields: [] },
        "user-1"
      )
    ).rejects.toThrow(/Workspace not found/);
    expect(mergeSettingsMock).not.toHaveBeenCalled();
  });
});
