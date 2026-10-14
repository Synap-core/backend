import { describe, it, expect } from "vitest";
import { buildRequestFromProposal, resolveProposalAction } from "../index.js";
import type { Proposal } from "@synap/database";

describe("resolveProposalAction — the verb a proposal row performs", () => {
  it("reads a flat receipt's dotted proposalType tail", () => {
    expect(resolveProposalAction({ proposalType: "entity.create", data: { title: "x" } })).toBe("create");
    expect(resolveProposalAction({ proposalType: "focus_session.create" })).toBe("create");
    expect(resolveProposalAction({ proposalType: "facet.attach" })).toBe("attach");
    expect(resolveProposalAction({ proposalType: "capability.enable" })).toBe("enable");
    expect(resolveProposalAction({ proposalType: "settings.update" })).toBe("update");
  });

  it("says a lifecycle transition as a move, dotted or stored", () => {
    expect(resolveProposalAction({ proposalType: "entity.transition" })).toBe("move");
    expect(
      resolveProposalAction({ proposalType: "transition", data: { changeType: "transition" } })
    ).toBe("move");
  });

  it("the dotted tail outranks a stored changeType", () => {
    expect(
      resolveProposalAction({ proposalType: "relation.create", data: { changeType: "update" } })
    ).toBe("create");
  });

  it("falls back to the stored changeType, then the bare proposalType", () => {
    expect(resolveProposalAction({ proposalType: "create", data: { changeType: "delete" } })).toBe("delete");
    expect(resolveProposalAction({ proposalType: "run", data: {} })).toBe("run");
  });

  it('says "update" only when the row says nothing', () => {
    expect(resolveProposalAction({ proposalType: "", data: null })).toBe("update");
    expect(resolveProposalAction({})).toBe("update");
  });

  it("buildRequestFromProposal stamps it: a flat receipt no longer reads Update", () => {
    const receipt = {
      id: "p1",
      workspaceId: null,
      targetType: "entity",
      targetId: "e1",
      proposalType: "entity.create",
      data: { title: "Acme", profileSlug: "company" },
      agentUserId: "a1",
      createdBy: "a1",
    } as unknown as Proposal;
    expect(buildRequestFromProposal(receipt).changeType).toBe("create");
  });
});
