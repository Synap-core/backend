/**
 * Approve-side reconciliation: the two guards added for the first client's
 * write failure.
 *
 *  1. A workspace TWIN row whose schema misses a key must fold onto the
 *     canonical (system/shared) row's slug — never mint a near-copy def
 *     (`knowledgeForm` → `knowledgeform`).
 *  2. A profile that did not resolve must never be reconciled with its SLUG in
 *     the id slot.
 *
 * Driven through the real pure core (`reconcileProposedProperties`, via the
 * spread of the actual module); only the DB reads and the def-create door are
 * mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getEffective, getById, getBySlug, createAndLink, warn } = vi.hoisted(
  () => ({
    getEffective: vi.fn(),
    getById: vi.fn(),
    getBySlug: vi.fn(),
    createAndLink: vi.fn(),
    warn: vi.fn(),
  })
);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {},
    ProfileResolutionService: class {
      getEffectiveProperties = getEffective;
    },
    ProfileRepository: class {
      getById = getById;
      getBySlug = getBySlug;
    },
  };
});

vi.mock("@synap-core/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap-core/core")>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn,
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

vi.mock("../profiles/create-and-link-property-def.js", () => ({
  createAndLinkPropertyDef: createAndLink,
}));

import { reconcileApprovedProperties } from "./reconcile-proposal-properties.js";

const TWIN = "11111111-1111-4111-8111-111111111111";
const CANON = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const USER = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
  createAndLink.mockResolvedValue({ propertyDef: { id: "new" }, link: null });
});

describe("reconcileApprovedProperties — workspace twin lens miss", () => {
  it("stores a key the twin misses under the CANONICAL slug, creates no def, and logs the lens miss", async () => {
    getById.mockResolvedValue({
      id: TWIN,
      slug: "knowledge",
      scope: "workspace",
    });
    getBySlug.mockResolvedValue({
      id: CANON,
      slug: "knowledge",
      scope: "system",
    });
    getEffective.mockImplementation(async (id: string) =>
      id === CANON ? [{ slug: "knowledgeForm" }, { slug: "ek_claim" }] : []
    );

    const r = await reconcileApprovedProperties({
      properties: { knowledgeForm: "insight" },
      profileId: TWIN,
      workspaceId: WS,
      userId: USER,
    });

    expect(r.properties).toEqual({ knowledgeForm: "insight" });
    expect(createAndLink).not.toHaveBeenCalled();
    expect(r.lensMisses).toEqual([
      { key: "knowledgeForm", canonicalSlug: "knowledgeForm" },
    ]);
    // Canonical lookup is by THIS kind's slug on the pod-wide floor only.
    expect(getBySlug).toHaveBeenCalledWith("knowledge");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "reconcile.lens_miss",
        profileSlug: "knowledge",
        twinProfileId: TWIN,
        workspaceId: WS,
        key: "knowledgeForm",
      }),
      expect.any(String)
    );
  });

  it("does not look for a canonical row when the resolved row IS the system row", async () => {
    getById.mockResolvedValue({
      id: CANON,
      slug: "knowledge",
      scope: "system",
    });
    getEffective.mockResolvedValue([{ slug: "ek_claim" }]);

    const r = await reconcileApprovedProperties({
      properties: { brandNewField: "x" },
      profileId: CANON,
      workspaceId: WS,
      userId: USER,
    });

    expect(getBySlug).not.toHaveBeenCalled();
    expect(r.lensMisses).toEqual([]);
    expect(createAndLink).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "brandnewfield", profileId: CANON })
    );
  });

  it("a FAILED canonical read stores verbatim and mints nothing (failed ≠ empty)", async () => {
    getById.mockResolvedValue({
      id: TWIN,
      slug: "knowledge",
      scope: "workspace",
    });
    getBySlug.mockRejectedValue(new Error("connection reset"));
    getEffective.mockResolvedValue([]);

    const props = { knowledgeForm: "insight" };
    const r = await reconcileApprovedProperties({
      properties: props,
      profileId: TWIN,
      workspaceId: WS,
      userId: USER,
    });

    expect(r.properties).toBe(props);
    expect(createAndLink).not.toHaveBeenCalled();
  });
});

describe("reconcileApprovedProperties — never a slug where an id belongs", () => {
  it.each([
    ["a slug", "knowledge"],
    ["null", null],
  ])(
    "profileId = %s ⇒ no schema read, no def, properties verbatim",
    async (_label, profileId) => {
      const props = { knowledgeForm: "insight" };
      const r = await reconcileApprovedProperties({
        properties: props,
        profileId,
        workspaceId: WS,
        userId: USER,
      });

      expect(getEffective).not.toHaveBeenCalled();
      expect(getById).not.toHaveBeenCalled();
      expect(createAndLink).not.toHaveBeenCalled();
      expect(r.properties).toBe(props);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ profileId }),
        expect.stringContaining("did not resolve")
      );
    }
  );
});
