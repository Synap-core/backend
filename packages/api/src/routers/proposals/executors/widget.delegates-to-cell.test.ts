/**
 * Legacy `widget/register` approve executor — back-compat, one writer.
 *
 * A pending `widget.register` proposal (filed before the Hub widget door went
 * through `defineCell`) must still approve, and must materialise through the
 * SAME `defineCell` the `cell/define` executor uses (no second insert), at the
 * REVIEWED scope. A payload with no code is still refused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  defineCalls: [] as Array<Record<string, unknown>>,
  proposalStatus: "pending" as string,
  registered: new Map<string, { execute: (a: unknown) => Promise<unknown> }>(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    select: () => ({
      from: () => ({ where: async () => [{ status: h.proposalStatus }] }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
  getDb: async () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  }),
}));

vi.mock("../../../services/cells/define-cell.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/cells/define-cell.js")
  >()),
  defineCell: async (input: Record<string, unknown>) => {
    h.defineCalls.push(input);
    return { typeKey: String(input.typeKey ?? "x"), changeType: "created" };
  },
}));

vi.mock("../execution-registry.js", () => ({
  registerProposalExecutor: (e: {
    key: string;
    execute: (a: unknown) => Promise<unknown>;
  }) => h.registered.set(e.key, e),
}));

vi.mock("./shared.js", () => ({ reportApproved: async () => undefined }));

const { registerWidgetExecutors } = await import("./widget.js");
registerWidgetExecutors();

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";

async function approve(inner: Record<string, unknown>, workspaceId = WS) {
  const exec = h.registered.get("widget/register")!;
  return exec.execute({
    proposal: { workspaceId, data: { data: inner } },
    userId: "u-1",
    input: { proposalId: "p-1" },
    deps: { emitProposalReviewed: () => undefined },
  });
}

const legacy = {
  typeKey: "legacy-widget",
  workspaceId: WS,
  name: "Legacy",
  description: "d",
  icon: "star",
  category: "ai",
  rendererType: "iframe",
  rendererSource: "<html>SynapWidget.onInit()</html>",
  configSchema: { a: 1 },
  defaultConfig: { b: 2 },
  defaultSize: { w: 4, h: 3 },
};

beforeEach(() => {
  h.defineCalls.length = 0;
  h.proposalStatus = "pending";
});

describe("widget/register delegates to defineCell", () => {
  it("approves a legacy payload through defineCell, with every stored field", async () => {
    await expect(approve(legacy)).resolves.toEqual({ success: true });
    expect(h.defineCalls).toHaveLength(1);
    expect(h.defineCalls[0]).toMatchObject({
      typeKey: "legacy-widget",
      workspaceId: WS,
      name: "Legacy",
      rendererType: "iframe",
      category: "ai",
      icon: "star",
      rendererSource: legacy.rendererSource,
      configSchema: { a: 1 },
      defaultConfig: { b: 2 },
      defaultSize: { w: 4, h: 3 },
      userId: "u-1",
    });
  });

  it("writes at the REVIEWED scope, not a payload workspace", async () => {
    await approve({ ...legacy, workspaceId: OTHER_WS });
    expect(h.defineCalls[0]!.workspaceId).toBe(WS);
  });

  it("never carries `native` through", async () => {
    await approve({ ...legacy, rendererType: "native" });
    expect(h.defineCalls[0]!.rendererType).toBeUndefined();
  });

  it("refuses a payload that carries no renderer code", async () => {
    await expect(
      approve({ ...legacy, rendererSource: undefined })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.defineCalls).toHaveLength(0);
  });

  it("does not re-run an already-approved proposal", async () => {
    h.proposalStatus = "approved";
    await expect(approve(legacy)).resolves.toMatchObject({
      alreadyApproved: true,
    });
    expect(h.defineCalls).toHaveLength(0);
  });
});
