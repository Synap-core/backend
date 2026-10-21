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
  expire: vi.fn(async () => [] as string[]),
  actioned: vi.fn(),
  current: "negotiating" as string | null,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
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
  expireProposalsStaleAfterMove: h.expire,
}));
vi.mock("@synap/events", () => ({ dispatchLifecycleTransition: h.emit }));
vi.mock(
  "../../../notifications/mark-proposal-notifications-actioned.js",
  () => ({
    markProposalNotificationsActioned: h.actioned,
  })
);
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: h.perm,
}));
// FB1020 B3: the proof is decided by `own-organise.ts` (its own tests); here
// only what the door does with the answer.
const own = vi.hoisted(() => ({ close: vi.fn(async () => false) }));
vi.mock("../../governance/own-organise.js", () => ({
  ownWorkOrganiseForTaskClose: own.close,
}));

import { moveStatus, statusMoveActorFor } from "../move-status.js";

const AGENT = { kind: "agent" as const, userId: "u1", agentUserId: "a1" };

beforeEach(() => {
  h.perm.mockReset();
  h.apply.mockReset();
  h.emit.mockReset();
  h.expire.mockClear();
  h.actioned.mockReset();
  h.current = "negotiating";
  own.close.mockReset();
  own.close.mockResolvedValue(false);
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

  it("a person's move expires the agent proposals it made stale; an agent's does not (F16)", async () => {
    h.perm.mockResolvedValue({ granted: true });
    h.expire.mockResolvedValueOnce(["p-stale"]);
    h.apply.mockResolvedValue({
      status: "moved",
      transition: { transitionId: "t1", actorKind: "human", to: "lost" },
    });
    await moveStatus({
      entityId: "e1",
      to: "lost",
      actor: { kind: "human", userId: "u1" },
    });
    expect(h.expire).toHaveBeenCalledTimes(1);
    expect(h.actioned).toHaveBeenCalledWith(["p-stale"]);

    h.apply.mockResolvedValue({
      status: "moved",
      transition: { transitionId: "t2", actorKind: "agent", to: "lost" },
    });
    await moveStatus({ entityId: "e1", to: "lost", actor: AGENT });
    expect(h.expire).toHaveBeenCalledTimes(1);
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

/**
 * fb1020: `in_progress` for a declared `in-progress` used to fail only after
 * the call. The door's input normaliser moves a case/separator variant to the
 * declared option, BEFORE governance — so the proposal, the write and the
 * event all carry the canonical key, and a human-only option stays human-only.
 */
describe("moveStatus input normaliser", () => {
  it("a case/separator variant moves to the declared option, governed as that option", async () => {
    h.perm.mockResolvedValue({
      granted: false,
      proposalId: "p7",
      proposalType: "entity.transition",
      reviewUrl: "x",
    });
    const r = await moveStatus({ entityId: "e1", to: "WON", actor: AGENT });
    expect(r).toMatchObject({ status: "proposed", proposalId: "p7" });
    expect(h.perm.mock.calls[0][0]).toMatchObject({
      lifecycleMove: { intoTerminal: true, humanOnly: true },
      data: { to: "won" },
    });
  });

  it("writes the declared key, never the caller's spelling", async () => {
    h.perm.mockResolvedValue({ granted: true });
    h.apply.mockResolvedValue({ status: "moved", transition: { to: "lost" } });
    await moveStatus({ entityId: "e1", to: " Lost", actor: AGENT });
    expect(h.apply.mock.calls[0][1]).toMatchObject({ to: "lost" });
  });

  it("an unrelated value is still refused, naming the options", async () => {
    const r = await moveStatus({ entityId: "e1", to: "closed", actor: AGENT });
    expect(r).toMatchObject({ status: "refused", code: "UNKNOWN_OPTION" });
    expect((r as { reason: string }).reason).toContain(
      "draft, negotiating, won, lost"
    );
    expect(h.perm).not.toHaveBeenCalled();
  });
});

describe("moveStatus door — FB1020 B3: closing its own fresh task", () => {
  it("an agent's terminal move carries the proof when own-organise grants it", async () => {
    own.close.mockResolvedValue(true);
    h.perm.mockResolvedValue({ granted: true, autoApprovedProposalId: "r1" });
    h.apply.mockResolvedValue({ status: "moved", transition: { to: "lost" } });
    await moveStatus({ entityId: "e1", to: "lost", actor: AGENT });
    expect(own.close).toHaveBeenCalledTimes(1);
    expect(h.perm.mock.calls[0][0]).toMatchObject({ ownWorkOrganise: true });
  });

  it("no proof without the grant, for a non-terminal move, or for a person", async () => {
    h.perm.mockResolvedValue({ granted: true });
    h.apply.mockResolvedValue({ status: "moved", transition: { to: "x" } });
    await moveStatus({ entityId: "e1", to: "lost", actor: AGENT });
    expect(h.perm.mock.calls[0][0]).not.toHaveProperty("ownWorkOrganise");

    own.close.mockResolvedValue(true);
    await moveStatus({ entityId: "e1", to: "draft", actor: AGENT });
    await moveStatus({
      entityId: "e1",
      to: "lost",
      actor: { kind: "human", userId: "u1" },
    });
    expect(own.close).toHaveBeenCalledTimes(1); // only the agent's terminal move asked
    for (const call of h.perm.mock.calls.slice(1)) {
      expect(call[0]).not.toHaveProperty("ownWorkOrganise");
    }
  });
});
