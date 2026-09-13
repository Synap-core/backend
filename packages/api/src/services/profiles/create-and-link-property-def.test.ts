import { describe, it, expect, vi } from "vitest";

// A property def is invisible to a profile until linked into
// profile_properties — this test asserts createAndLinkPropertyDef always
// performs BOTH steps (create, then link), which is the whole point of the
// SSOT helper (both the governed hub route's auto-apply branch AND the
// `property_def/create` proposal executor call through it instead of
// duplicating the two-write sequence).

const h = vi.hoisted(() => ({
  createPropertyDef: vi.fn(async () => ({
    propertyDef: { id: "propdef-1", slug: "priority" },
  })),
  linkProperty: vi.fn(async () => ({
    link: { profileId: "profile-1", propertyDefId: "propdef-1" },
  })),
  order: [] as string[],
  gate: vi.fn(async () => {}),
  level: vi.fn(() => "additive"),
}));

vi.mock("@synap/database", () => ({
  getDb: vi.fn(async () => ({})),
  ProfileResolutionService: class {
    async resolveProfile(id: string) {
      return { id, scope: "system", workspaceId: null, userId: null };
    }
  },
}));

// The gate's own behaviour is proven in routers/profile-schema-write-access.test.ts.
// Here only its PLACE matters: evaluated before the def exists.
vi.mock("../../utils/profile-schema-write-access.js", () => ({
  assertProfileSchemaWrite: h.gate,
  propertyLinkLevel: h.level,
}));

vi.mock("../../routers/property-defs.js", () => ({
  propertyDefsRouter: {
    createCaller: () => ({ create: h.createPropertyDef }),
  },
}));

vi.mock("../../routers/profile-properties.js", () => ({
  profilePropertiesRouter: {
    createCaller: () => ({ link: h.linkProperty }),
  },
}));

import { createAndLinkPropertyDef } from "./create-and-link-property-def.js";

describe("createAndLinkPropertyDef", () => {
  it("refuses BEFORE creating the def — a refused link can never leave an orphan", async () => {
    h.createPropertyDef.mockClear();
    h.linkProperty.mockClear();
    h.gate.mockRejectedValueOnce(new Error("Pod admin access required"));

    await expect(
      createAndLinkPropertyDef({
        userId: "user-1",
        workspaceId: "ws-1",
        profileId: "profile-1",
        slug: "priority",
        valueType: "string",
        required: true,
      })
    ).rejects.toThrow("Pod admin access required");

    expect(h.level).toHaveBeenCalledWith(
      expect.objectContaining({ required: true, alreadyLinked: false })
    );
    expect(h.createPropertyDef).not.toHaveBeenCalled();
    expect(h.linkProperty).not.toHaveBeenCalled();
  });

  it("creates the property def AND links it to the profile", async () => {
    const result = await createAndLinkPropertyDef({
      userId: "user-1",
      workspaceId: "ws-1",
      profileId: "profile-1",
      slug: "priority",
      valueType: "string",
      required: true,
      displayOrder: 2,
    });

    expect(h.createPropertyDef).toHaveBeenCalledTimes(1);
    expect(h.createPropertyDef).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "priority", profileId: "profile-1" })
    );

    expect(h.linkProperty).toHaveBeenCalledTimes(1);
    expect(h.linkProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-1",
        propertyDefId: "propdef-1",
        required: true,
        displayOrder: 2,
      })
    );

    expect(result.propertyDef.id).toBe("propdef-1");
    expect(result.link).not.toBeNull();
  });

  it("skips the link step when no profileId is given (global def)", async () => {
    h.createPropertyDef.mockClear();
    h.linkProperty.mockClear();

    const result = await createAndLinkPropertyDef({
      userId: "user-1",
      workspaceId: "ws-1",
      slug: "global-field",
      valueType: "string",
    });

    expect(h.createPropertyDef).toHaveBeenCalledTimes(1);
    expect(h.linkProperty).not.toHaveBeenCalled();
    expect(result.link).toBeNull();
  });
});
