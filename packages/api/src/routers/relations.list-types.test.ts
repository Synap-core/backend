/**
 * `relations.listTypes` must CARRY `inverseLabel` — the connections rule
 * (`@synap-core/types/connections`) labels an incoming edge with it ("Employs"
 * for works_at). It is stored on the def (`uiHints.inverseLabel`) and was
 * dropped by this projection. Driven through the real router, from a stored
 * def row to the wire output — nothing hand-built downstream of the projection.
 */
import { describe, expect, it, vi } from "vitest";

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }));

vi.mock("../access/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../access/index.js")>()),
  scopedDb: () => ({ findMany: mockFindMany }),
}));

import { relationsRouter } from "./relations.js";

const def = (slug: string, displayName: string, uiHints: unknown) => ({
  id: `def-${slug}`,
  slug,
  displayName,
  description: null,
  isDirectional: true,
  uiHints,
  workspaceId: null,
});

describe("relations.listTypes", () => {
  it("returns the stored inverseLabel, null when the def has none", async () => {
    mockFindMany.mockResolvedValue([
      def("works_at", "Works at", {
        inverseLabel: "Employs",
        category: "work",
      }),
      def("reports_to", "Reports to", {}),
    ]);
    const caller = relationsRouter.createCaller({
      authenticated: true,
      userId: "user-1",
      workspaceId: "00000000-0000-4000-8000-000000000010",
    } as never);

    const { types } = await caller.listTypes();

    expect(types).toEqual([
      expect.objectContaining({
        type: "works_at",
        label: "Works at",
        inverseLabel: "Employs",
      }),
      expect.objectContaining({
        type: "reports_to",
        label: "Reports to",
        inverseLabel: null,
      }),
    ]);
  });
});
