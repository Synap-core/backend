/**
 * The lens-collapsed attach's widen-only property FILL is a real write, so it
 * goes through the repository's own emitter like `update()` does (RV1 S13). It
 * used to write `entity_facets` directly and emit nothing — the widen was
 * invisible to realtime and automations — and returned the stale pre-write
 * copy when the row vanished.
 *
 * Drives the real `attach()` against a recording db; role resolution and
 * property validation are stubbed (not under test), `emitCompleted` is spied.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { FacetRepository } from "./facet-repository.js";
import {
  ProfileResolutionService,
  PropertyValidationService,
} from "../services/index.js";

const USER = "99999999-9999-4999-8999-999999999999";
const OPS = "22222222-2222-4222-8222-222222222222";
const ENTITY = "33333333-3333-4333-8333-333333333333";

const EXISTING = {
  id: "facet-1",
  entityId: ENTITY,
  profileId: "role-client",
  workspaceId: null,
  properties: { handoffStatus: "won" },
};

function stubSharedRole() {
  vi.spyOn(
    ProfileResolutionService.prototype,
    "resolveProfile"
  ).mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      id: "role-client",
      slug: "client",
      scope: "shared",
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

function collidingDb(opts: { vanished?: boolean } = {}) {
  return {
    insert: () => ({
      values: () => ({
        returning: async () => {
          throw Object.assign(new Error("dup"), { code: "23505" });
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => (opts.vanished ? [] : [{ ...EXISTING, ...v }]),
        }),
      }),
    }),
    query: {
      entityFacets: { findFirst: async () => EXISTING },
      entities: { findFirst: async () => ({ type: "person" }) },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const repoFor = (db: any) => new FacetRepository(db, {} as any);

const ATTACH = {
  entityId: ENTITY,
  profileSlug: "client",
  userId: USER,
  workspaceId: OPS,
  properties: { handoffStatus: "new", slaTier: "gold" },
};

describe("FacetRepository lens-collapsed fill — announced through the emitter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits `update` with the WRITTEN row", async () => {
    stubSharedRole();
    const emit = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(FacetRepository.prototype as any, "emitCompleted")
      .mockResolvedValue(undefined);
    await repoFor(collidingDb()).attach(ATTACH, USER);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "update",
      expect.objectContaining({
        id: "facet-1",
        properties: { handoffStatus: "won", slaTier: "gold" },
      }),
      USER
    );
  });

  it("skipEvent leaves the emit to the caller's post-commit hook", async () => {
    stubSharedRole();
    const emit = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(FacetRepository.prototype as any, "emitCompleted")
      .mockResolvedValue(undefined);
    await repoFor(collidingDb()).attach({ ...ATTACH, skipEvent: true }, USER);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a row that vanished before the write is an error, never the stale copy", async () => {
    stubSharedRole();
    vi.spyOn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      FacetRepository.prototype as any,
      "emitCompleted"
    ).mockResolvedValue(undefined);
    await expect(
      repoFor(collidingDb({ vanished: true })).attach(ATTACH, USER)
    ).rejects.toThrow("Facet not found");
  });
});
