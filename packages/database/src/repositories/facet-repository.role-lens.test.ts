/**
 * W2b ROLE PRINCIPLE at the ONE facet write door: a shared/system role is one
 * hat pod-wide, so `FacetRepository.attach` STORES its facet pod-wide (NULL)
 * whatever lens the caller attached from — the only stamp every lens that has
 * the role can see (`facetVisibilityConditions` lens W = W OR NULL). A
 * workspace-private role keeps the caller's lens. A second lens attaching the
 * same shared role lands on the existing pod-wide facet and its overlay values
 * are FILLED (widen-only), never silently dropped.
 *
 * Drives the real `attach()` against a recording db; only role resolution and
 * property validation are stubbed (they are not what is under test).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { FacetRepository } from "./facet-repository.js";
import {
  ProfileResolutionService,
  PropertyValidationService,
} from "../services/index.js";
import { storedFacetWorkspaceId } from "../utils/facet-visibility.js";

const USER = "99999999-9999-4999-8999-999999999999";
const CRM = "11111111-1111-4111-8111-111111111111";
const OPS = "22222222-2222-4222-8222-222222222222";
const ENTITY = "33333333-3333-4333-8333-333333333333";

function stubRole(scope: "shared" | "system" | "workspace") {
  vi.spyOn(
    ProfileResolutionService.prototype,
    "resolveProfile"
  ).mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      id: "role-client",
      slug: "client",
      scope,
      profileKind: "role",
      applicableKinds: null,
    } as any
  );
  vi.spyOn(
    PropertyValidationService.prototype,
    "validateProperties"
  ).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (props: any) =>
      ({ valid: true, errors: [], normalized: props }) as any
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recordingDb(opts: { existing?: any } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          if (opts.existing) {
            throw Object.assign(new Error("dup"), { code: "23505" });
          }
          inserted.push(v);
          return [{ id: "facet-new", ...v }];
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updated.push(v);
            return [{ ...opts.existing, ...v }];
          },
        }),
      }),
    }),
    query: {
      entityFacets: { findFirst: async () => opts.existing ?? null },
      entities: { findFirst: async () => ({ type: "person" }) },
    },
  };
  return { db, inserted, updated };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const repoFor = (db: any) => new FacetRepository(db, {} as any);

describe("storedFacetWorkspaceId (write-side lens rule)", () => {
  it("shared and system roles are stored pod-wide; a workspace role keeps the lens", () => {
    expect(storedFacetWorkspaceId("shared", CRM)).toBeNull();
    expect(storedFacetWorkspaceId("system", CRM)).toBeNull();
    expect(storedFacetWorkspaceId("workspace", CRM)).toBe(CRM);
    expect(storedFacetWorkspaceId(undefined, CRM)).toBe(CRM);
  });
});

describe("FacetRepository.attach — W2b role principle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a SHARED role attached from the CRM lens is stored pod-wide (visible in Operations too)", async () => {
    stubRole("shared");
    const { db, inserted } = recordingDb();
    await repoFor(db).attach(
      {
        entityId: ENTITY,
        profileSlug: "client",
        userId: USER,
        workspaceId: CRM,
        skipEvent: true,
      },
      USER
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0].workspaceId).toBeNull();
  });

  it("the role still resolves and validates under the CALLER's lens (overlay properties)", async () => {
    stubRole("shared");
    const { db } = recordingDb();
    await repoFor(db).attach(
      {
        entityId: ENTITY,
        profileSlug: "client",
        userId: USER,
        workspaceId: CRM,
        properties: { handoffStatus: "new" },
        skipEvent: true,
      },
      USER
    );
    expect(
      ProfileResolutionService.prototype.resolveProfile
    ).toHaveBeenCalledWith("client", USER, CRM);
    expect(
      PropertyValidationService.prototype.validateProperties
    ).toHaveBeenCalledWith({ handoffStatus: "new" }, "role-client", CRM, {
      enforceRequired: false,
    });
  });

  it("a WORKSPACE-private role keeps the caller's lens (unchanged)", async () => {
    stubRole("workspace");
    const { db, inserted } = recordingDb();
    await repoFor(db).attach(
      {
        entityId: ENTITY,
        profileSlug: "client",
        userId: USER,
        workspaceId: CRM,
        skipEvent: true,
      },
      USER
    );
    expect(inserted[0].workspaceId).toBe(CRM);
  });

  it("a second lens attaching the same shared role FILLS its missing overlay keys, never clobbers", async () => {
    stubRole("shared");
    const existing = {
      id: "facet-1",
      entityId: ENTITY,
      profileId: "role-client",
      workspaceId: null,
      properties: { handoffStatus: "won" },
    };
    const { db, updated } = recordingDb({ existing });
    const facet = await repoFor(db).attach(
      {
        entityId: ENTITY,
        profileSlug: "client",
        userId: USER,
        workspaceId: OPS,
        properties: { handoffStatus: "new", slaTier: "gold" },
        skipEvent: true,
      },
      USER
    );
    expect(updated).toHaveLength(1);
    expect(updated[0].properties).toEqual({
      handoffStatus: "won",
      slaTier: "gold",
    });
    expect(facet.properties).toEqual({ handoffStatus: "won", slaTier: "gold" });
  });
});
