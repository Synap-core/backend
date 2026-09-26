/**
 * POST /cells/define — the typeKey PROVENANCE FLOOR.
 *
 * THE DEFECT
 * ==========
 * This door declared `typeKey: z.string()` and handed it straight to
 * `defineCell`, while the tRPC door (`widgetDefinitions.upsert`) had guarded the
 * same field for months. So an operator-scoped key could POST
 * `typeKey: "cell:<vendor>:<key>"` and land on the row an INSTALLED package
 * cell occupies — `defineCell` writes `rendererSource` unconditionally and
 * demotes `trustLevel` only on an `externalHosts` CHANGE, so the swapped code
 * would inherit the vendor's approved `connect-src` grant AND its trust level.
 * Two shipped surfaces (`apps/made-for-you.ts`, `rest/installed.ts`) read the
 * prefix back as provenance.
 *
 * The rule, unchanged and now shared: a door may UPDATE a namespaced row that
 * already exists, but may never MINT one.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  defineCalls: [] as Array<Record<string, unknown>>,
  gateCalls: [] as Array<Record<string, unknown>>,
  gateResult: { granted: true } as Record<string, unknown>,
  /** Rows the provenance-floor lookup finds. Empty ⇒ the key would be MINTED. */
  existingRows: [] as Array<{ id: string }>,
}));

// PARTIAL mock (`importOriginal`) — a TOTAL replacement dies at COLLECTION time
// the moment any file in the import graph uses an export the hand-listed object
// omits, taking the whole file dark. See `database-mock-total-ratchet`. Only
// `getDb` is faked; the real query builders (`eq`/`and`/`isNull`) and the real
// schema columns are used, so the provenance floor's lookup is exercised as
// written rather than against stubs.
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: async () => ({
    query: { widgetDefinitions: { findMany: async () => [] } },
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => h.existingRows }) }),
    }),
  }),
}));

vi.mock("../../../services/cells/define-cell.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/cells/define-cell.js")
  >("../../../services/cells/define-cell.js");
  return {
    ...actual,
    defineCell: async (input: Record<string, unknown>) => {
      h.defineCalls.push(input);
      return {
        typeKey: String(input.typeKey ?? "generated:x"),
        changeType: "created" as const,
      };
    },
  };
});

vi.mock("./_shared.js", async (importOriginal) => ({
  // Partial: the routes also import the real `httpStatusForTrpcError`.
  ...(await importOriginal<typeof import("./_shared.js")>()),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
  verifyWorkspaceAccess: async () => true,
  verifyWorkspaceReadAccess: async () => true,
}));

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.gateCalls.push(opts);
    return h.gateResult;
  },
  proposedMessageFor: (_t: string | undefined, msg: string) => msg,
}));

import { registerCellsRoutes } from "./cells.js";
import type { HubHono, HubVariables } from "./_shared.js";

const WS = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.write"]);
    c.set("userId", "user-1");
    await next();
  });
  registerCellsRoutes(app);
  return app;
}

function defineReq(extra: Record<string, unknown> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "My Cell",
      rendererSource: "export default () => null",
      workspaceId: WS,
      ...extra,
    }),
  };
}

beforeEach(() => {
  h.defineCalls.length = 0;
  h.gateCalls.length = 0;
  h.gateResult = { granted: true };
  h.existingRows = [];
});

describe("POST /cells/define — namespaced typeKey may be updated, never minted", () => {
  it("REJECTS minting cell:<pkg>:<key> — the vendor-row overwrite", async () => {
    const res = await buildApp().request(
      "/cells/define",
      defineReq({ typeKey: "cell:acme-charts:pie" })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("namespaced");
    // The renderer source never reached the write door.
    expect(h.defineCalls).toHaveLength(0);
  });

  it("REJECTS minting generated:<slug> — the forged AI-provenance claim", async () => {
    const res = await buildApp().request(
      "/cells/define",
      defineReq({ typeKey: "generated:not-really-ai" })
    );

    expect(res.status).toBe(400);
    expect(h.defineCalls).toHaveLength(0);
  });

  it("ALLOWS updating a namespaced row that already exists (install-then-tweak)", async () => {
    h.existingRows = [{ id: "row-1" }];

    const res = await buildApp().request(
      "/cells/define",
      defineReq({ typeKey: "cell:acme-charts:pie" })
    );

    expect(res.status).toBe(201);
    expect(h.defineCalls[0]?.typeKey).toBe("cell:acme-charts:pie");
  });

  it("leaves a bare kebab typeKey alone — the floor only touches namespaces", async () => {
    const res = await buildApp().request(
      "/cells/define",
      defineReq({ typeKey: "win-rate-gauge" })
    );

    expect(res.status).toBe(201);
    expect(h.defineCalls[0]?.typeKey).toBe("win-rate-gauge");
  });

  it("runs BEFORE the governance gate — a forged key never becomes a proposal", async () => {
    // A reviewer must never be shown a proposal whose (forged) origin is part
    // of what makes it look approvable.
    const res = await buildApp().request(
      "/cells/define",
      defineReq({ typeKey: "cell:acme-charts:pie", agentUserId: AGENT })
    );

    expect(res.status).toBe(400);
    expect(h.gateCalls).toHaveLength(0);
  });

  it("carries typeKey into the gate `data` so approval materialises the reviewed key", async () => {
    // Without this the approved cell lands under `generated:<slug(name)>` — the
    // reviewer approves one key and the pod writes another.
    h.existingRows = [{ id: "row-1" }];
    h.gateResult = {
      granted: false,
      proposalId: "p-1",
      proposalType: "cell.define",
      summary: "s",
      reasoning: "r",
      reviewPath: "/open/p-1",
      reviewUrl: "u",
    };

    const res = await buildApp().request(
      "/cells/define",
      defineReq({ typeKey: "cell:acme-charts:pie", agentUserId: AGENT })
    );

    expect(res.status).toBe(202);
    expect(h.gateCalls[0]?.data).toMatchObject({
      typeKey: "cell:acme-charts:pie",
    });
  });
});

describe("POST /cells/define — a contradictory definition is a 400, not a 500", () => {
  it("rejects contentKind + viewTypes with the actionable message", async () => {
    // `defineCell` is mocked here, so re-create the real door's throw to prove
    // the ROUTE's mapping (the write door's own rule is covered by
    // `define-cell.contradiction.test.ts`).
    const { CellDefinitionError } =
      await import("../../../services/cells/define-cell.js");
    const mod = await import("../../../services/cells/define-cell.js");
    const spy = vi
      .spyOn(mod, "defineCell")
      .mockRejectedValueOnce(new CellDefinitionError("contradictory pair"));

    const res = await buildApp().request(
      "/cells/define",
      defineReq({ contentKind: "widget", viewTypes: ["table"] })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("contradictory pair");
    spy.mockRestore();
  });
});
