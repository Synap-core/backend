/**
 * `view/create` approval of a proposal filed BEFORE `views.create` validated
 * filters: its `query.filters` go through the same stored-filter normaliser as
 * `views.execute` / `views.update` — repaired where unambiguous, dropped where
 * not — so the approval still reaches `views.create` with grammar-valid
 * filters instead of failing there as BAD_REQUEST.
 *
 * EXECUTABLE: drives the real executor body; `viewsRouter.createCaller` is
 * mocked to capture exactly what `create` receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ViewFiltersSchema } from "@synap-core/types";

const create = vi.fn(async (_args: Record<string, unknown>) => ({}));
vi.mock("../../views.js", () => ({
  viewsRouter: { createCaller: () => ({ create }) },
}));
vi.mock("../executors/shared.js", () => ({ reportApproved: () => undefined }));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("@synap/database", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => [{ id: "p1" }] }),
      }),
    }),
  },
  proposals: { __table: "proposals" },
  eq: () => ({}),
  and: () => ({}),
  getWorkspaceMembership: async () => ({ role: "owner" }),
}));
vi.mock("@synap/database/schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database/schema")>()),
  ProposalStatus: { APPROVED: "approved", PENDING: "pending" },
}));

const { registerViewExecutors } = await import("../executors/view.js");
const { proposalExecRegistry } = await import("../execution-registry.js");

registerViewExecutors();
const executor = proposalExecRegistry.resolveExact("view/create");

async function approve(query: unknown) {
  if (!executor) throw new Error("view/create executor not registered");
  return executor.execute({
    proposal: {
      id: "p1",
      targetType: "view",
      workspaceId: null,
      targetId: "00000000-0000-4000-8000-0000000000aa",
      data: { data: { name: "Board", type: "table", query } },
    },
    userId: "user-1",
    input: { proposalId: "p1" },
    deps: { emitProposalReviewed: () => undefined },
  } as never);
}

describe("view/create approval normalises legacy proposal filters", () => {
  beforeEach(() => create.mockClear());

  it("repairs legacy shapes, drops the unrepairable, and create gets grammar-valid filters", async () => {
    const result = await approve({
      filters: [
        { field: "properties.n", operator: "between", value: [1, 5] },
        { field: "properties.s", operator: "in", value: "open" },
        { field: "status", operator: "eq", value: "open" }, // unrepairable
      ],
      limit: 50,
    });
    expect(result.success).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const query = create.mock.calls[0]![0].query as {
      filters: unknown[];
      limit: number;
    };
    expect(query.limit).toBe(50);
    expect(query.filters).toEqual([
      { field: "properties.n", operator: "greater_than_or_equal", value: 1 },
      { field: "properties.n", operator: "less_than_or_equal", value: 5 },
      { field: "properties.s", operator: "in", value: ["open"] },
    ]);
    // What create receives passes the create door's own grammar.
    expect(ViewFiltersSchema.safeParse(query.filters).success).toBe(true);
  });

  it("a proposal without a query still approves with none", async () => {
    await approve(undefined);
    expect(create.mock.calls[0]![0].query).toBeUndefined();
  });
});
