/**
 * Seam test: a running verb cannot call through a tool row that is OFF, even
 * one of its own required tools.
 *
 * Why it matters for add-ons (founder decision D6, document b387ca45 §6): an
 * add-on declares no tool of its own. Its actions `require` its base's tool
 * rows (Apify's `apify_api`), so `verbAct.toolIds` names the BASE's tool. The
 * base's access switch is that tool row's `approved`. When it is off, every
 * provider call an add-on action makes through it must fall through to the
 * gate, which refuses it: "if the base is off, the add-on cannot run".
 *
 * `coveredByVerb` (external-dispatch.ts) lets a decided verb call its own
 * required tools without a second gate, but ONLY an approved tool. This test
 * pins that clause: without `tool.approved === true` the call skips the gate
 * and an add-on keeps running on a base that was switched off.
 *
 * Real door code; the tool read, the gate and the proposal insert are stubbed.
 * Nothing is dispatched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const BASE_TOOL = {
  id: "tool-apify",
  name: "apify_api",
  approved: false,
  createdBy: "owner-1",
  credentialRef: "vault://apify-token",
  authBinding: "static",
  workspaceId: null,
};
let toolRows: unknown[] = [BASE_TOOL];
const gate = vi.fn(async (_input: { capabilityId: string }) => ({
  decision: "deny" as const,
  reason: "This capability is installed but not yet enabled.",
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: (cols?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: () => {
            const rows =
              table === (actual as any).tools
                ? cols
                  ? [{ id: BASE_TOOL.id, name: BASE_TOOL.name }]
                  : toolRows
                : [];
            return {
              limit: async () => rows,
              then: (resolve: (v: unknown) => unknown) => resolve(rows),
            };
          },
        }),
      }),
    },
  };
});

vi.mock("../services/capabilities/gate-capability-execution.js", () => ({
  gateCapabilityExecution: (input: { capabilityId: string }) => gate(input),
}));
vi.mock("../services/capabilities/capability-registry.js", () => ({
  containerMemberKey: (kind: string, id: string) => `${kind}:${id}`,
  loadContainerRefs: async () => new Map(),
}));
vi.mock("../services/links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCapabilityMemberParts: async () => [],
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async () => ({ id: "prop-1" }),
}));

const { triggerProviderAction } = await import("./external-dispatch.js");

/** The add-on action `apify_linkedin_profile`, already decided, calling its base's tool. */
const ADDON_CALL = {
  userId: "owner-1",
  provider: BASE_TOOL.credentialRef,
  method: "POST",
  path: "/acts/some~actor/run-sync-get-dataset-items",
  workspaceId: "ws-1",
  verbAct: { skillId: "skill-addon-action", toolIds: [BASE_TOOL.id] },
};

describe("a decided verb calling its base's tool row while it is off", () => {
  beforeEach(() => {
    gate.mockClear();
    toolRows = [BASE_TOOL];
  });

  it("is gated, refused, and nothing runs", async () => {
    const out = await triggerProviderAction(ADDON_CALL);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate.mock.calls[0]![0]).toMatchObject({
      capabilityId: BASE_TOOL.id,
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/^Nothing ran/);
  });
});
