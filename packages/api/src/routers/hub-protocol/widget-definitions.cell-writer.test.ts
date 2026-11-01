/**
 * Hub `upsertWidgetDef` is a TRANSPORT onto the one cell writer.
 *
 * Proven here:
 *  1. A granted write goes through `defineCell` (so rendererType derivation,
 *     deps validation and the realtime emit are the cell door's) and carries the
 *     wire fields (typeKey, name, rendererType, source, config, size).
 *  2. The gate is filed as `cell.define` (NOT the legacy `widget.register`) with
 *     the full define payload, and a "proposed" outcome writes nothing.
 *  3. A rendererType the caller did not name is left to `defineCell` to derive.
 *  4. No rendererSource is a 400, not a shell row; a contradictory definition
 *     from `defineCell` surfaces as BAD_REQUEST.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../context.js";

const h = vi.hoisted(() => ({
  defineCalls: [] as Array<Record<string, unknown>>,
  gateCalls: [] as Array<Record<string, unknown>>,
  gateResult: { granted: true } as Record<string, unknown>,
  defineError: null as Error | null,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ typeKey: "my-widget" }] }),
      }),
    }),
  }),
}));

vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (a: Record<string, unknown>) => {
    h.gateCalls.push(a);
    return h.gateResult;
  },
  proposedMessageFor: (_t: string, fallback: string) => fallback,
}));

vi.mock("../../services/cells/define-cell.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/cells/define-cell.js")
  >()),
  defineCell: async (input: Record<string, unknown>) => {
    if (h.defineError) throw h.defineError;
    h.defineCalls.push(input);
    return { typeKey: String(input.typeKey), changeType: "created" as const };
  },
}));

vi.mock(
  "../../services/cells/namespaced-type-key.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../services/cells/namespaced-type-key.js")
    >()),
    assertMayWriteNamespacedTypeKey: async () => undefined,
  })
);

const { hubWidgetDefinitionsRouter } = await import("./widget-definitions.js");
const { CellDefinitionError } =
  await import("../../services/cells/define-cell.js");

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

function caller() {
  return hubWidgetDefinitionsRouter.createCaller({
    authenticated: true as const,
    userId: USER,
    scopes: ["hub-protocol.write", "hub-protocol.read"],
  } as unknown as Context);
}

const base = {
  userId: USER,
  workspaceId: WS,
  typeKey: "my-widget",
  name: "My widget",
  rendererSource: "<html>SynapWidget.onInit()</html>",
};

beforeEach(() => {
  h.defineCalls.length = 0;
  h.gateCalls.length = 0;
  h.gateResult = { granted: true };
  h.defineError = null;
});

describe("hub upsertWidgetDef → defineCell", () => {
  it("writes through defineCell, carrying the wire fields", async () => {
    const res = await caller().upsertWidgetDef({
      ...base,
      rendererType: "iframe",
      description: "d",
      icon: "star",
      category: "ai",
      configSchema: { a: 1 },
      defaultConfig: { b: 2 },
      defaultSize: { w: 4, h: 3 },
    });
    expect(res.status).toBe("ok");
    expect(h.defineCalls).toHaveLength(1);
    expect(h.defineCalls[0]).toMatchObject({
      typeKey: "my-widget",
      workspaceId: WS,
      name: "My widget",
      description: "d",
      icon: "star",
      category: "ai",
      rendererType: "iframe",
      rendererSource: base.rendererSource,
      configSchema: { a: 1 },
      defaultConfig: { b: 2 },
      defaultSize: { w: 4, h: 3 },
      userId: USER,
    });
  });

  it("leaves rendererType to defineCell when the caller names none", async () => {
    await caller().upsertWidgetDef(base);
    expect(h.defineCalls[0]!.rendererType).toBeUndefined();
  });

  it("files the gate as cell.define with the full payload, never widget.register", async () => {
    await caller().upsertWidgetDef({ ...base, rendererType: "iframe" });
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      subjectType: "cell",
      action: "define",
    });
    expect(h.gateCalls[0]!.data).toMatchObject({
      typeKey: "my-widget",
      name: "My widget",
      rendererSource: base.rendererSource,
      rendererType: "iframe",
    });
  });

  it("a proposal writes nothing and returns the proposal envelope", async () => {
    h.gateResult = {
      proposalId: "p-1",
      proposalType: "cell",
      summary: "s",
      reasoning: "r",
      reviewPath: "/p",
      reviewUrl: "u",
    };
    const res = await caller().upsertWidgetDef(base);
    expect(res.status).toBe("proposed");
    expect(h.defineCalls).toHaveLength(0);
  });

  it("refuses a definition with no renderer source", async () => {
    await expect(
      caller().upsertWidgetDef({ ...base, rendererSource: undefined })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.gateCalls).toHaveLength(0);
    expect(h.defineCalls).toHaveLength(0);
  });

  it("maps a contradictory definition to BAD_REQUEST", async () => {
    h.defineError = new CellDefinitionError("contradiction");
    await expect(caller().upsertWidgetDef(base)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
