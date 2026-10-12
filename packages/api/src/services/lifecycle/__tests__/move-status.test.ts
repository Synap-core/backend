/**
 * The `moveStatus` DOOR's ordering (the storage half is proven on PGlite in
 * `@synap/database` apply-status-move.pglite.test.ts):
 *  - governance receives the move classified from the TARGET option;
 *  - a proposed move writes nothing and emits nothing;
 *  - an agent acting on a false belief gets a conflict BEFORE any proposal;
 *  - a moved write emits exactly one transition;
 *  - an approved replay skips governance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  perm: vi.fn(),
  apply: vi.fn(),
  emit: vi.fn(),
  current: "negotiating" as string | null,
}));

vi.mock("@synap/database", () => ({
  db: {},
  resolveStatusMoveTarget: vi.fn(async () => ({
    ok: true,
    target: {
      entityId: "e1",
      entityType: "deal",
      workspaceId: "w1",
      facetId: null,
      role: null,
      current: h.current,
      lifecycle: {
        propertySlug: "commercialStage",
        propertyDefId: "d1",
        declaredOnProfileId: "p1",
        unclassified: [],
        options: [
          { key: "draft", category: "open" },
          { key: "negotiating", category: "active" },
          { key: "won", category: "done", humanOnly: true },
          { key: "lost", category: "lost" },
        ],
      },
    },
  })),
  classifyStatusMove: (
    lc: {
      options: Array<{ key: string; category: string; humanOnly?: boolean }>;
    },
    to: string
  ) => {
    const o = lc.options.find((x) => x.key === to);
    return o
      ? {
          intoTerminal: o.category === "done" || o.category === "lost",
          humanOnly: o.humanOnly === true,
        }
      : null;
  },
  applyStatusMove: h.apply,
}));
vi.mock("@synap/events", () => ({ emitLifecycleTransition: h.emit }));
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: h.perm,
}));

import { moveStatus, statusMoveActorFor } from "../move-status.js";

const AGENT = { kind: "agent" as const, userId: "u1", agentUserId: "a1" };

beforeEach(() => {
  h.perm.mockReset();
  h.apply.mockReset();
  h.emit.mockReset();
  h.current = "negotiating";
});

describe("moveStatus door", () => {
  it("governs with the target option's classification, then writes and emits once", async () => {
    h.perm.mockResolvedValue({ granted: true, autoApprovedProposalId: "r1" });
    h.apply.mockResolvedValue({ status: "moved", transition: { to: "lost" } });
    const r = await moveStatus({ entityId: "e1", to: "lost", actor: AGENT });
    expect(r.status).toBe("moved");
    expect(h.perm).toHaveBeenCalledTimes(1);
    expect(h.perm.mock.calls[0][0]).toMatchObject({
      subjectType: "entity",
      action: "transition",
      agentUserId: "a1",
      lifecycleMove: { intoTerminal: true, humanOnly: false },
      data: { expectedFrom: "negotiating", to: "lost" },
    });
    expect(h.apply.mock.calls[0][1]).toMatchObject({ proposalId: "r1" });
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("a proposed move writes nothing and emits nothing", async () => {
    h.perm.mockResolvedValue({
      granted: false,
      proposalId: "p9",
      proposalType: "entity.transition",
      reviewUrl: "x",
    });
    const r = await moveStatus({ entityId: "e1", to: "won", actor: AGENT });
    expect(r).toMatchObject({ status: "proposed", proposalId: "p9" });
    expect(h.perm.mock.calls[0][0].lifecycleMove).toEqual({
      intoTerminal: true,
      humanOnly: true,
    });
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("an agent's false belief is a conflict before any proposal", async () => {
    const r = await moveStatus({
      entityId: "e1",
      expectedFrom: "draft",
      to: "lost",
      actor: AGENT,
    });
    expect(r).toEqual({
      status: "conflict",
      expectedFrom: "draft",
      actual: "negotiating",
    });
    expect(h.perm).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("refuses an unknown option without governing", async () => {
    const r = await moveStatus({ entityId: "e1", to: "closed", actor: AGENT });
    expect(r.status).toBe("refused");
    expect(h.perm).not.toHaveBeenCalled();
  });

  it("an approved replay skips governance", async () => {
    h.apply.mockResolvedValue({ status: "moved", transition: {} });
    await moveStatus({
      entityId: "e1",
      to: "lost",
      expectedFrom: "negotiating",
      actor: AGENT,
      approvedProposalId: "p9",
    });
    expect(h.perm).not.toHaveBeenCalled();
    expect(h.apply.mock.calls[0][1]).toMatchObject({ proposalId: "p9" });
  });

  it("an UNATTRIBUTED agent is governed on the AI ladder, never as a person, and is strict", async () => {
    h.perm.mockResolvedValue({ granted: true });
    h.apply.mockResolvedValue({ status: "moved", transition: {} });
    await moveStatus({
      entityId: "e1",
      to: "lost",
      actor: { kind: "agent", userId: "u1", agentUserId: null },
    });
    expect(h.perm.mock.calls[0][0]).toMatchObject({
      source: "intelligence",
      agentUserId: undefined,
    });
    expect(h.apply.mock.calls[0][1]).toMatchObject({ strict: true });
  });

  it("a person's move is governed as the user and wins (not strict)", async () => {
    h.perm.mockResolvedValue({ granted: true });
    h.apply.mockResolvedValue({ status: "moved", transition: {} });
    await moveStatus({
      entityId: "e1",
      to: "lost",
      actor: { kind: "human", userId: "u1" },
    });
    expect(h.perm.mock.calls[0][0]).toMatchObject({ source: "user" });
    expect(h.apply.mock.calls[0][1]).toMatchObject({ strict: false });
  });

  it("an approval replay with no agent is strict compare-and-set", async () => {
    h.apply.mockResolvedValue({ status: "moved", transition: {} });
    const r = await moveStatus({
      entityId: "e1",
      to: "lost",
      expectedFrom: "draft",
      actor: { kind: "human", userId: "approver" },
      approvedProposalId: "p9",
    });
    // The belief is already false: a stale approval, nothing written.
    expect(r).toEqual({
      status: "conflict",
      expectedFrom: "draft",
      actual: "negotiating",
    });
    expect(h.apply).not.toHaveBeenCalled();
  });
});

describe("statusMoveActorFor (who a request-door move is made by)", () => {
  const WIRE = { userId: "u1", req: {} };
  it("an attributed agent is an agent", () => {
    expect(
      statusMoveActorFor(WIRE, { source: "intelligence", agentUserId: "a1" })
        .actor
    ).toEqual({ kind: "agent", userId: "u1", agentUserId: "a1" });
  });
  it("a hub / service key with no agent is an UNATTRIBUTED agent, never human", () => {
    const hubCtx = {
      userId: "u1",
      source: "intelligence",
      isHubProtocol: true,
    };
    expect(statusMoveActorFor(hubCtx, {}).actor).toEqual({
      kind: "agent",
      userId: "u1",
      agentUserId: null,
    });
    // Even when the body claims a person or the system.
    expect(statusMoveActorFor(hubCtx, { source: "user" }).actor.kind).toBe(
      "agent"
    );
    expect(statusMoveActorFor(hubCtx, { source: "system" }).actor.kind).toBe(
      "agent"
    );
    expect(
      statusMoveActorFor(WIRE, { source: "intelligence" }).actor
    ).toMatchObject({ kind: "agent", agentUserId: null });
  });
  it("a wire request cannot claim the system; server code can", () => {
    expect(statusMoveActorFor(WIRE, { source: "system" }).actor.kind).toBe(
      "human"
    );
    expect(
      statusMoveActorFor({ userId: "u1" }, { source: "system" }).actor.kind
    ).toBe("system");
  });
  it("an internal caller holding a decision replays it", () => {
    expect(
      statusMoveActorFor(
        { userId: "u1", agentUserId: "a1", governanceProposalId: "p1" },
        {}
      )
    ).toEqual({
      actor: { kind: "agent", userId: "u1", agentUserId: "a1" },
      approvedProposalId: "p1",
    });
  });
});
