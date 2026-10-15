/**
 * `workspaces.templateHealth` (review U1-backend): the browser reads the
 * pod's ONE template-health answer instead of judging "update available"
 * itself. Pinned: the read is access-scoped through the ONE membership
 * predicate, and the service's rows — `drifted`, the apply `state`,
 * `awaitingApproval`, `applyWarning` — arrive on the reply as the service
 * produced them (reachability, not shape).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  ids: vi.fn(),
  health: vi.fn(),
}));

vi.mock("../utils/workspace-membership.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../utils/workspace-membership.js")
  >()),
  getUserWorkspaceIds: (...a: unknown[]) => m.ids(...a),
}));
vi.mock("../services/template-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/template-health.js")>()),
  listWorkspaceTemplateHealth: (...a: unknown[]) => m.health(...a),
}));

import { workspaceCatalogRouter } from "./workspaces.js";

const caller = () =>
  workspaceCatalogRouter.createCaller({
    authenticated: true,
    userId: "user-1",
  } as never);

const NOT_FINISHED = {
  workspaceId: "ws-crm",
  workspaceName: "CRM",
  packageSlug: "crm",
  drifted: true,
  state: "failed",
  awaitingApproval: [],
  applyWarning:
    "Not finished: the last update of crm failed. Run `synap templates update crm` to resume.",
};
const CURRENT = {
  workspaceId: "ws-brand",
  workspaceName: "Brand",
  packageSlug: "brand",
  drifted: false,
  awaitingApproval: [],
  applyWarning: null,
};

beforeEach(() => {
  m.ids.mockReset().mockResolvedValue(["ws-crm", "ws-brand"]);
  m.health.mockReset().mockResolvedValue([NOT_FINISHED, CURRENT]);
});

describe("workspaces.templateHealth", () => {
  it("is a query, scoped to the caller's spaces, serving the pod's rows as they are", async () => {
    expect(
      workspaceCatalogRouter._def.procedures.templateHealth._def.type
    ).toBe("query");
    const reply = await caller().templateHealth();
    expect(m.ids).toHaveBeenCalledWith("user-1");
    // The reader rides along: it decides `pendingDataChanges.needsPodAdmin`.
    expect(m.health).toHaveBeenCalledWith(["ws-crm", "ws-brand"], "user-1");
    expect(reply).toEqual({
      workspaces: [NOT_FINISHED, CURRENT],
      driftedCount: 1,
      total: 2,
    });
  });

  it("driftedOnly keeps only what needs the person (behind, or not finished)", async () => {
    const reply = await caller().templateHealth({ driftedOnly: true });
    expect(reply.workspaces).toEqual([NOT_FINISHED]);
    expect(reply.total).toBe(2);
  });
});
