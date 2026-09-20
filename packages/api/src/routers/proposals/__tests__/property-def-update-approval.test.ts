/**
 * `property_def/update` — the APPROVAL half of the new EDIT door.
 *
 * A governed write door with no approval half is this repo's most repeated
 * silent-success defect. Here the catch-all would in fact THROW (its honesty
 * gate: no executor + no materializer writer ⇒ NOT_IMPLEMENTED ⇒
 * APPROVAL_FAILED) — loud, but the human's approval would still change
 * nothing. So this suite DRIVES the executor rather than scanning source, and
 * asserts the write actually happens through the SAME helper the direct-apply
 * branch uses.
 *
 * NOT covered, measured: the row-ownership gate and slug-conflict check live
 * inside `propertyDefs.update`, which `updatePropertyDef` is mocked away to
 * here. They are re-run at approval time by construction (the helper delegates
 * to that procedure) and have their own suite.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const PROPOSALS = { __table: "proposals" } as const;

let updates: { values: Record<string, unknown> }[] = [];

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ values });
        return { where: async () => undefined };
      },
    }),
  },
  proposals: PROPOSALS,
  eq: () => ({}),
}));

const applyUpdate = vi.fn(async (_input: Record<string, unknown>) => ({
  propertyDef: { id: "def-1" },
}));
vi.mock("../../../services/profiles/update-property-def.js", () => ({
  updatePropertyDef: (input: Record<string, unknown>) => applyUpdate(input),
}));

const { registerPropertyDefExecutors } =
  await import("../executors/property-def.js");
const { proposalExecRegistry } = await import("../execution-registry.js");

registerPropertyDefExecutors();

const APPROVER = "human-approver";

const run = async (data: Record<string, unknown>, workspaceId = "ws-1") => {
  const executor = proposalExecRegistry.resolveExact("property_def/update");
  if (!executor) throw new Error("property_def/update executor not registered");
  return executor.execute({
    proposal: {
      id: "p1",
      targetType: "property_def",
      targetId: "def-1",
      proposalType: "update",
      workspaceId,
      agentUserId: "agent-1",
      data: { data },
    },
    payload: { data },
    userId: APPROVER,
    input: { proposalId: "p1" },
    deps: {
      emitProposalReviewed: vi.fn(),
      reportProposalOutcome: vi.fn(),
    },
  } as never);
};

beforeEach(() => {
  updates = [];
  applyUpdate.mockClear();
});

describe("property_def/update approval", () => {
  it("is registered as its OWN executor, not the catch-all", () => {
    const executor = proposalExecRegistry.resolveExact("property_def/update");
    expect(executor?.key).toBe("property_def/update");
  });

  it("applies the stored declaration through the shared update helper", async () => {
    const result = await run({
      propertyDefId: "def-1",
      workspaceId: "ws-9",
      constraints: { enum: ["gotcha", "lesson"] },
      valueType: "string",
      slug: "ek-type",
    });

    expect(result).toMatchObject({ success: true });
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(applyUpdate).toHaveBeenCalledWith({
      // The APPROVER is the acting identity at apply time — the row's owner
      // gate is evaluated against the human who approved.
      userId: APPROVER,
      workspaceId: "ws-9",
      propertyDefId: "def-1",
      slug: "ek-type",
      valueType: "string",
      constraints: { enum: ["gotcha", "lesson"] },
    });
    expect(updates[0]?.values).toMatchObject({
      status: "approved",
      reviewedBy: APPROVER,
    });
  });

  it("falls back to the proposal's own workspace when the payload names none", async () => {
    await run({ propertyDefId: "def-1", uiHints: { displayName: "EK" } });
    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" })
    );
  });

  it("refuses — and writes nothing — when the proposal carries no propertyDefId", async () => {
    await expect(run({ constraints: { enum: ["a"] } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("refuses when no workspace can be resolved at all", async () => {
    await expect(
      run({ propertyDefId: "def-1", constraints: {} }, "")
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(applyUpdate).not.toHaveBeenCalled();
  });
});
