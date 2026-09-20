/**
 * `profiles.updatePropertyDef` — the EDIT door for an existing property def.
 *
 * WHY IT EXISTS: the create door is slug-idempotent and never convergent, and
 * the founder's rule is no silent convergence — so the thing must be editable
 * through a door. `propertyDefs.update` (tRPC) already owned the row's edit
 * rules but was unreachable from any agent surface; this procedure is that
 * surface, and it is GOVERNED.
 *
 * Driven through the REAL procedure and the REAL `updatePropertyDef` helper,
 * with only the DB-edge router (`propertyDefs.update`) and the gate mocked —
 * the gate's own behaviour has its own suites; what is measured here is that
 * this door CONSULTS it and honours both answers.
 *
 * NOT covered, measured: the row-ownership rule (overlay → workspace editor,
 * base def → profile owner, global → pod admin) and the slug-conflict check
 * live in `propertyDefs.update`, which is mocked here — deliberately, because
 * re-asserting them would be testing a copy. They have their own suite
 * (`routers/property-defs.write-access.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** What the gate answers — swapped per test. */
  gateResult: { granted: true } as Record<string, unknown>,
  gateCalls: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<Record<string, unknown>>,
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
  checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
    h.gateCalls.push(opts);
    return h.gateResult;
  }),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({})),
}));

// The DB edge — the procedure this door delegates to rather than re-writing.
vi.mock("../property-defs.js", () => ({
  propertyDefsRouter: {
    createCaller: () => ({
      update: async (input: Record<string, unknown>) => {
        h.updateCalls.push(input);
        return { propertyDef: { id: input.id, ...input } };
      },
    }),
  },
}));

import { hubProfilesRouter } from "./profiles.js";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const DEF = "7f191e1b-70ba-48d4-9424-91db53441b8e";

const caller = () => hubProfilesRouter.createCaller({ userId: USER } as never);

const edit = (extra: Record<string, unknown>) =>
  caller().updatePropertyDef({
    userId: USER,
    workspaceId: WS,
    propertyDefId: DEF,
    ...extra,
  } as never);

beforeEach(() => {
  h.gateResult = { granted: true };
  h.gateCalls.length = 0;
  h.updateCalls.length = 0;
});

describe("hub profiles.updatePropertyDef — governance", () => {
  it("proposes (and writes NOTHING) when the gate says propose", async () => {
    h.gateResult = { proposalId: "prop-1" };

    const result = await edit({ constraints: { enum: ["a", "b"] } });

    expect(result).toMatchObject({
      status: "proposed",
      proposalId: "prop-1",
    });
    // The whole point of a gated door: no write on the propose branch.
    expect(h.updateCalls).toHaveLength(0);
  });

  it("gates on the (property_def, update) pair — the key that decides the floor", async () => {
    await edit({ valueType: "number" });
    expect(h.gateCalls[0]).toMatchObject({
      subjectType: "property_def",
      action: "update",
      userId: USER,
      workspaceId: WS,
    });
  });

  it("applies through the shared helper when granted, and reports applied", async () => {
    const result = await edit({
      constraints: { enum: ["gotcha", "lesson"] },
      uiHints: { displayName: "EK type" },
    });

    expect(h.updateCalls).toEqual([
      {
        id: DEF,
        constraints: { enum: ["gotcha", "lesson"] },
        uiHints: { displayName: "EK type" },
      },
    ]);
    expect(result).toMatchObject({ status: "applied", proposalId: null });
    expect((result as { propertyDef: { id: string } }).propertyDef.id).toBe(
      DEF
    );
  });

  it("carries a declared field it was NOT given as absent, never as a null overwrite", async () => {
    await edit({ constraints: { enum: ["a"] } });
    // valueType/uiHints/slug were not declared: they must not reach the update
    // at all (a present-but-undefined key is how a rename gets silently wiped).
    expect(Object.keys(h.updateCalls[0]).sort()).toEqual(["constraints", "id"]);
  });
});

describe("hub profiles.updatePropertyDef — input floors", () => {
  it("refuses an update that names nothing, instead of reporting success", async () => {
    await expect(edit({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.gateCalls).toHaveLength(0);
    expect(h.updateCalls).toHaveLength(0);
  });

  it("refuses an unknown valueType before it reaches the PG enum cast", async () => {
    await expect(edit({ valueType: "text" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(h.updateCalls).toHaveLength(0);
  });

  it("normalises a renamed slug through the ONE slugifier — in the APPLY and in the gate data", async () => {
    await edit({ slug: "ek_type" });
    expect(h.updateCalls[0].slug).toBe("ek-type");
    // The proposal payload is built from this `data`, so the executor applies
    // the same normalised slug the direct branch would have.
    expect((h.gateCalls[0].data as Record<string, unknown>).slug).toBe(
      "ek-type"
    );
  });
});
