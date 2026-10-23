/**
 * marketplace-install — a view install names the views it wrote.
 *
 * The desktop install dialog lands on the object it installed. Every other
 * single-object kind already said which one (capability `key`, cell
 * `typeKey`, skill `id`, automation `automations[].id`); the view arm returned
 * only NAMES, so an installed view could never be opened from the install.
 * `viewIds` lists the views written, in order: an UPDATED re-install gives the
 * existing id, a created one the new id, and a create that was only PROPOSED
 * (no view yet) gives none.
 *
 * The views router and the db are mocked so the test drives the real view arm
 * of `applyMarketInstall` with a supplied definition (no catalog lookup).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./create-from-definition.js", () => ({
  createCapabilityFromDefinition: vi.fn(),
  loadCapabilityTemplate: vi.fn(),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(),
}));
vi.mock("./cells/define-cell.js", () => ({ defineCell: vi.fn() }));

const { viewCreate, viewUpdate } = vi.hoisted(() => ({
  viewCreate: vi
    .fn()
    // "Table": created.
    .mockResolvedValueOnce({ view: { id: "v-new" }, status: "created" })
    // "Calendar": only proposed — there is no view yet.
    .mockResolvedValueOnce({
      view: null,
      status: "proposed",
      proposalId: "p-1",
    }),
  viewUpdate: vi.fn(async () => ({})),
}));
vi.mock("../../routers/views.js", () => ({
  viewsRouter: {
    createCaller: () => ({ create: viewCreate, update: viewUpdate }),
  },
}));

// The workspace already holds "Board" from this package (a re-install updates
// it); `await db.select().from().where()` resolves to those rows.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const rows = [
    {
      id: "v-old",
      name: "Board",
      metadata: { marketSource: { packageSlug: "task-views", baseline: {} } },
    },
  ];
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    then: (resolve: (value: unknown) => unknown) => resolve(rows),
  };
  return {
    ...actual,
    db: { select: () => chain },
    getWorkspaceMembership: vi.fn(async () => ({ role: "owner" })),
  };
});

import { applyMarketInstall } from "./marketplace-install.js";

describe("applyMarketInstall — view ids", () => {
  it("lists the views it wrote: updated and created ids, never one for a proposed create", async () => {
    const result = (await applyMarketInstall({
      kind: "view",
      slug: "task-views",
      userId: "user-1",
      workspaceId: "ws-1",
      definition: {
        views: [
          { name: "Board", type: "kanban" },
          { name: "Table", type: "table" },
          { name: "Calendar", type: "calendar" },
        ],
      },
    })) as {
      kind: string;
      created: string[];
      updated: string[];
      viewIds: string[];
    };

    expect(viewUpdate).toHaveBeenCalledTimes(1);
    expect(viewCreate).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("view");
    expect(result.updated).toEqual(["Board"]);
    expect(result.created).toEqual(["Table", "Calendar"]);
    expect(result.viewIds).toEqual(["v-old", "v-new"]);
  });
});
