/**
 * marketplace-install — per-item isolation (partial install with warnings).
 *
 * Regression: `applyMarketInstall` case "automation" ran `caller.create` inside
 * a bare `for` loop with NO try/catch, so the FIRST automation that failed to
 * create aborted the whole `market.install` — every later automation silently
 * never ran. This exercises the fix: one failing automation is reported as
 * `{status:"error"}` in the returned `automations` array while the others still
 * install (the partial-install-with-warnings pattern shared with
 * createCapabilityFromDefinition and applyPackagePostWorkspace).
 *
 * Downstream appliers + the automations router are mocked so the test isolates
 * the loop's failure-isolation behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../workspace-creation-service.js", () => ({
  createWorkspaceFromDefinitionIdempotent: vi.fn(),
}));
vi.mock("./create-from-definition.js", () => ({
  createCapabilityFromDefinition: vi.fn(),
  loadCapabilityTemplate: vi.fn(),
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(),
}));
vi.mock("./cells/define-cell.js", () => ({ defineCell: vi.fn() }));

// One automation succeeds, the next throws — the loop must isolate the failure.
const { createAutomationMock } = vi.hoisted(() => ({
  createAutomationMock: vi
    .fn()
    .mockResolvedValueOnce({ id: "auto-ok" })
    .mockRejectedValueOnce(new Error("flow validation failed")),
}));
vi.mock("../../routers/automations.js", () => ({
  automationsRouter: {
    createCaller: () => ({ create: createAutomationMock }),
  },
}));

// db.select().from().where().limit() → [] (no existing automation to reuse);
// getWorkspaceMembership → a member so the acting-workspace gate passes.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [] as unknown[],
  };
  return {
    ...actual,
    db: { select: () => chain },
    getWorkspaceMembership: vi.fn(async () => ({ role: "owner" })),
  };
});

import { applyMarketInstall } from "./marketplace-install.js";

describe("applyMarketInstall — automation per-item isolation", () => {
  const origFetch = global.fetch;
  const origCpUrl = process.env.CONTROL_PLANE_URL;

  beforeEach(() => {
    createAutomationMock.mockClear();
    process.env.CONTROL_PLANE_URL = "https://cp.example.test";
    // CP by-key resolve returns a definition with two automations.
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            package: {
              definition: {
                automations: [
                  { name: "First", triggerType: "manual" },
                  { name: "Second", triggerType: "manual" },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = origFetch;
    if (origCpUrl === undefined) delete process.env.CONTROL_PLANE_URL;
    else process.env.CONTROL_PLANE_URL = origCpUrl;
  });

  it("installs the good automation and reports the failing one instead of aborting", async () => {
    const result = (await applyMarketInstall({
      kind: "automation",
      slug: "some-automations",
      userId: "user-1",
      workspaceId: "ws-1",
    })) as { kind: string; automations: Array<Record<string, unknown>> };

    // BOTH automations were attempted — the first failure did not abort the loop.
    expect(createAutomationMock).toHaveBeenCalledTimes(2);

    expect(result.kind).toBe("automation");
    expect(result.automations).toHaveLength(2);
    expect(result.automations[0]).toMatchObject({
      name: "First",
      status: "created",
      id: "auto-ok",
    });
    expect(result.automations[1]).toMatchObject({
      name: "Second",
      status: "error",
      message: "flow validation failed",
    });
  });
});
