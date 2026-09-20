/**
 * define_kind receipt honesty + slug normalisation — driven through the REAL
 * seam, end to end.
 *
 * The chain under test is the one an agent actually walks:
 *   defineProfile (this door)
 *     → hub `profiles.createPropertyDef` (the REAL procedure, scope middleware
 *       swapped for `t.procedure` the way proposals.update-expected-revision
 *       does — API-key validation needs a live key row and has its own suites)
 *       → the REAL `createAndLinkPropertyDef`
 *         → `property-defs.create` / `profile-properties.link` (mocked: these
 *           are the DB edge, and the slug-idempotent `existing: true` return is
 *           the exact fact this suite is about).
 *
 * Nothing between the door and that edge is hand-built, so a projection dropped
 * anywhere in the middle fails here. Two defects are pinned:
 *
 *  1. HONESTY. `property-defs.create` returns the stored row untouched on a slug
 *     hit. The door reported `status: "applied"` with a `constraints: {}` the
 *     caller never declared and an `updatedAt` six weeks old — a receipt for a
 *     write that never happened, on the very path the two-phase define flow
 *     tells agents to re-walk. It must report `unchanged` and name what it
 *     ignored. (Convergence — actually updating the def — is deliberately NOT
 *     implemented; that is a product decision.)
 *  2. NORMALISATION. `ek_type` was slugified to `ek-type` by the approve-side
 *     reconciliation door and HARD-REJECTED by this one. Both now use the one
 *     `slugifyPropertyKey`.
 *
 * NOT covered, measured: the PropertyValidationService write path still compares
 * a caller's raw key against the stored slug (`ek_type` !== `ek-type`), so a
 * writer passing snake_case is still reported unmodeled. That is a separate
 * door and a separate decision — see the report.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Slug → stored def row, seeded to simulate a def that already exists. */
  store: new Map<string, Record<string, unknown>>(),
  createCalls: [] as Array<Record<string, unknown>>,
  createProfileCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../middleware/api-key-auth.js")>();
  const { t } =
    await vi.importActual<typeof import("../../trpc.js")>("../../trpc.js");
  return { ...actual, scopedProcedure: () => t.procedure };
});

vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/permission-check.js")>()),
  // Operator path: granted, so the door takes the auto-apply branch this suite
  // is about. The gate's own behaviour has its own suites.
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));

vi.mock("../../utils/profile-schema-write-access.js", () => ({
  assertProfileSchemaWrite: vi.fn(async () => {}),
  propertyLinkLevel: vi.fn(() => "additive"),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({})),
  ProfileResolutionService: class {
    async resolveProfile(id: string) {
      return { id, scope: "system", workspaceId: null, userId: null };
    }
  },
}));

// The DB edge. `create` reproduces property-defs.create's contract exactly:
// slug hit → return the STORED row with `existing: true`, writing nothing.
vi.mock("../property-defs.js", () => ({
  propertyDefsRouter: {
    createCaller: () => ({
      create: async (input: Record<string, unknown>) => {
        h.createCalls.push(input);
        const stored = h.store.get(input.slug as string);
        if (stored) return { propertyDef: stored, existing: true };
        const created = {
          id: `def-${input.slug}`,
          slug: input.slug,
          valueType: input.valueType,
          constraints: input.constraints ?? {},
          uiHints: input.uiHints ?? {},
        };
        h.store.set(input.slug as string, created);
        return { propertyDef: created };
      },
    }),
  },
}));

vi.mock("../profile-properties.js", () => ({
  profilePropertiesRouter: {
    createCaller: () => ({
      link: async (input: Record<string, unknown>) => ({ link: { ...input } }),
    }),
  },
}));

import { hubProfilesRouter } from "./profiles.js";
import { defineProfile } from "./define-profile.js";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const PROFILE = "33333333-3333-4333-8333-333333333333";

/** The real hub procedure, plus a recording stand-in for createProfile (the
 *  profile write is not the seam under test — the FIELD path is). */
function caller() {
  const hub = hubProfilesRouter.createCaller({ userId: USER } as never);
  return {
    profiles: {
      createProfile: async (input: Record<string, unknown>) => {
        h.createProfileCalls.push(input);
        return {
          status: "applied",
          profile: { id: PROFILE, slug: input.slug },
        };
      },
      createPropertyDef: hub.createPropertyDef,
    },
  } as never;
}

/** The per-field ledger the door returns, or a hard failure if the door errored. */
function ledgerOf(outcome: Awaited<ReturnType<typeof defineProfile>>) {
  if (!outcome.ok) throw new Error(`door errored: ${outcome.error}`);
  return (outcome.result.properties ?? []) as Array<Record<string, unknown>>;
}

const define = (slug: string, fields: Array<Record<string, unknown>>) =>
  defineProfile(
    caller(),
    {
      userId: USER,
      workspaceId: WS,
      slug,
      displayName: "Knowledge",
      fields,
    },
    { door: "synap_define_kind", fieldsParam: "properties" }
  );

beforeEach(() => {
  h.store.clear();
  h.createCalls.length = 0;
  h.createProfileCalls.length = 0;
});

describe("define_kind — receipt honesty on an existing property def", () => {
  it("reports `unchanged` (never `applied`) and names the ignored declaration", async () => {
    // The live repro: `ek-type` exists with EMPTY constraints; the caller
    // re-declares it with an enum.
    h.store.set("ek-type", {
      id: "7f191e1b-70ba-48d4-9424-91db53441b8e",
      slug: "ek-type",
      valueType: "string",
      constraints: {},
      uiHints: { label: "ek_type" },
    });

    const outcome = await define("knowledge", [
      {
        slug: "ek-type",
        valueType: "string",
        constraints: { enum: ["gotcha", "lesson", "decision"] },
      },
    ]);

    expect(outcome.ok).toBe(true);
    const ledger = ledgerOf(outcome);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe("unchanged");
    expect(ledger[0].status).not.toBe("applied");
    // REACHABILITY, not shape: the ignored VALUE must arrive at the door.
    expect(ledger[0].ignored).toEqual([
      {
        field: "constraints",
        declared: { enum: ["gotcha", "lesson", "decision"] },
        stored: {},
      },
    ]);
    // "Be clear about the issue" — the receipt must spell the divergence out,
    // declared value AND stored value, not just say "unchanged".
    const message = String(ledger[0].message);
    expect(message).toContain("constraints");
    expect(message).toContain('["gotcha","lesson","decision"]');
    // ...and, since this door deliberately never converges, it must NAME the
    // door that can apply the change, plus the id to aim it at.
    expect(message).toContain("updatePropertyDef");
    expect(message).toContain("7f191e1b-70ba-48d4-9424-91db53441b8e");
  });

  it("still reports `applied` for a def that really was written", async () => {
    const outcome = await define("knowledge", [
      { slug: "content", valueType: "string" },
    ]);
    const ledger = ledgerOf(outcome);
    expect(ledger[0].status).toBe("applied");
    expect(ledger[0].ignored).toBeUndefined();
  });

  it("reports `unchanged` with NO ignored list when the declaration matches", async () => {
    h.store.set("ek-type", {
      id: "def-ek-type",
      slug: "ek-type",
      valueType: "string",
      constraints: { enum: ["a"] },
      uiHints: {},
    });
    const outcome = await define("knowledge", [
      { slug: "ek-type", valueType: "string", constraints: { enum: ["a"] } },
    ]);
    const ledger = ledgerOf(outcome);
    expect(ledger[0].status).toBe("unchanged");
    expect(ledger[0].ignored).toEqual([]);
  });
});

describe("define_kind — ONE slug normalisation", () => {
  it("normalises a snake_case FIELD key and says so, instead of rejecting it", async () => {
    const outcome = await define("knowledge", [
      { slug: "ek_type", valueType: "string" },
    ]);

    // Reached the DB edge kebab-cased — the same answer the approve-side
    // reconciliation door gives for the same input.
    expect(h.createCalls.map((c) => c.slug)).toEqual(["ek-type"]);

    const ledger = ledgerOf(outcome);
    expect(ledger[0]).toMatchObject({
      slug: "ek-type",
      normalizedFrom: "ek_type",
      status: "applied",
    });
  });

  it("normalises a snake_case KIND slug (the door used to reject it outright)", async () => {
    await define("finding_class", []);
    expect(h.createProfileCalls[0].slug).toBe("finding-class");
  });

  it("leaves an already-kebab slug alone and claims no normalisation", async () => {
    const outcome = await define("knowledge", [
      { slug: "ek-type", valueType: "string" },
    ]);
    expect(h.createProfileCalls[0].slug).toBe("knowledge");
    const ledger = ledgerOf(outcome);
    expect(ledger[0].normalizedFrom).toBeUndefined();
  });
});
