/**
 * Connected plan — the materializer's contract, driven with STUB callers (the
 * honest unit boundary: each caller is the seam to an existing door, see
 * `utils/plan-callers.ts`).
 *
 * Pinned: pass order (projects → entities → subjects → relations → sessions
 * parents-first → edges → documents), ref resolution across kinds, and
 * ALL-OR-NONE — the first failed step stops the run and EVERYTHING that had
 * applied reaches `compensate`, then `CompositePlanApplyError` names the step.
 */

import { describe, expect, it, vi } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  CompositePlanApplyError,
  materializeCompositeGraph,
  type MaterializeResult,
  type PlanCallers,
} from "./materialize-composite.js";

function stubPlanCallers(
  overrides: Partial<{
    sessionCreate: PlanCallers["sessionCaller"]["create"];
    linkCreate: PlanCallers["linkCaller"]["create"];
    trackCreate: PlanCallers["trackCaller"]["create"];
  }> = {}
) {
  const calls: string[] = [];
  let n = 0;
  const callers: PlanCallers = {
    projectCaller: {
      create: vi.fn(async (input) => {
        calls.push(`project:${input.name}`);
        return { id: "project-1", linked: false };
      }),
      setSubject: vi.fn(async (input) => {
        calls.push(`subject:${input.projectId}=${input.subjectEntityId}`);
      }),
    },
    sessionCaller: {
      create: vi.fn(
        overrides.sessionCreate ??
          (async (input) => {
            calls.push(
              `session:${input.goal}:project=${input.projectId}:subject=${input.subjectEntityId}${input.trackId ? `:track=${input.trackId}` : ""}`
            );
            return { id: `session-${++n}` };
          })
      ),
      update: vi.fn(async (input) => {
        calls.push(`update:${input.sessionId}:${JSON.stringify(input.patch)}`);
        return {
          before: { title: "Old", goal: "old goal", status: "active" },
          after: {
            title: "Old",
            goal: input.patch.goal ?? "old goal",
            status: input.patch.status ?? "active",
          },
        };
      }),
    },
    linkCaller: {
      create: vi.fn(
        overrides.linkCreate ??
          (async (input) => {
            calls.push(
              `link:${input.type}:${input.fromSessionId}>${input.toSessionId}`
            );
            return {
              linkId: `link-${input.fromSessionId}`,
              preExisting: false,
            };
          })
      ),
      createCrossKind: vi.fn(async (input) => {
        calls.push(
          `wait:${input.fromSessionId}>${input.toKind}:${input.toId}${input.option ? `#${input.option}` : ""}`
        );
        return { linkId: `xl-${input.toId}`, preExisting: false };
      }),
      remove: vi.fn(async (input) => {
        calls.push(
          `unlink:${input.fromSessionId}>${input.toKind}:${input.toId}`
        );
        return { removed: true };
      }),
    },
    documentCaller: {
      create: vi.fn(async (input) => {
        calls.push(`document:${input.title}:session=${input.sessionId}`);
        return { id: "doc-1" };
      }),
    },
    trackCaller: {
      create: vi.fn(
        overrides.trackCreate ??
          (async (input) => {
            calls.push(
              `track:${input.name}:project=${input.projectId}:parent=${input.parentGoalId ?? null}`
            );
            return { id: `track-${input.name}`, linked: false };
          })
      ),
      addBlockers: vi.fn(async (input) => {
        calls.push(
          `track-blockers:${input.trackId}>${input.blockerTrackIds.join(",")}`
        );
        return {
          linkIds: input.blockerTrackIds.map(
            (b: string) => `tl-${input.trackId}-${b}`
          ),
        };
      }),
    },
    compensate: vi.fn(async (_applied: MaterializeResult) => ({
      undone: { project: ["project-1"] },
      notCompensated: [],
    })),
  };
  return { callers, calls };
}

const entityCaller = {
  create: vi.fn(async (input: { title: string; projectId?: string }) => ({
    id: `entity-${input.title}`,
    projectIdSeen: input.projectId,
  })),
};
const relationCaller = { create: vi.fn(async () => ({ id: "rel-1" })) };

const plan: CompositeProposalOperation[] = [
  // Declared out of dependency order on purpose: order comes from the passes.
  { op: "create_link", type: "blocked_by", fromRef: "s2", toRef: "s1" },
  {
    op: "create_document",
    ref: "spec",
    title: "Spec",
    content: "# Spec",
    sessionRef: "s1",
  },
  {
    op: "create_session",
    ref: "s1",
    goal: "spec",
    parentRef: "s0",
    projectRef: "p1",
  },
  {
    op: "create_session",
    ref: "s2",
    goal: "import",
    parentRef: "s0",
    projectRef: "p1",
  },
  {
    op: "create_session",
    ref: "s0",
    goal: "root",
    projectRef: "p1",
    subjectRef: "acme",
  },
  {
    op: "create_entity",
    ref: "acme",
    profileSlug: "company",
    title: "Acme",
    projectRef: "p1",
  },
  {
    op: "create_project",
    ref: "p1",
    name: "Acme onboarding",
    subjectRef: "acme",
  },
];

describe("materializeCompositeGraph — connected plan", () => {
  it("applies in dependency order and resolves refs across kinds", async () => {
    const { callers, calls } = stubPlanCallers();
    const result = await materializeCompositeGraph(
      plan,
      entityCaller,
      relationCaller,
      undefined,
      {
        planCallers: callers,
      }
    );

    expect(calls).toEqual([
      "project:Acme onboarding",
      "subject:project-1=entity-Acme",
      "session:root:project=project-1:subject=entity-Acme",
      "session:spec:project=project-1:subject=null",
      "session:import:project=project-1:subject=null",
      // Edges run once EVERY session exists, in declaration order: the link op
      // is declared first, the parent fields after it.
      "link:blocked_by:session-3>session-2",
      "link:spawned_from:session-2>session-1",
      "link:spawned_from:session-3>session-1",
      "document:Spec:session=session-2",
    ]);
    // The entity was filed into the plan's own project.
    expect(entityCaller.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Acme", projectId: "project-1" })
    );
    expect(result.sessions.map((s) => [s.ref, s.sessionId])).toEqual([
      ["s0", "session-1"],
      ["s1", "session-2"],
      ["s2", "session-3"],
    ]);
    expect(result.projects).toEqual([
      expect.objectContaining({
        ref: "p1",
        projectId: "project-1",
        linked: false,
        subjectEntityId: "entity-Acme",
      }),
    ]);
    expect(result.documents[0]).toEqual(
      expect.objectContaining({
        ref: "spec",
        documentId: "doc-1",
        recordedOnSessionId: "session-2",
      })
    );
    expect(callers.compensate).not.toHaveBeenCalled();
  });

  it("ALL-OR-NONE: a failed step stops the run and everything applied reaches compensate", async () => {
    let created = 0;
    const { callers } = stubPlanCallers({
      sessionCreate: async (input) => {
        if (input.goal === "import") throw new Error("session door exploded");
        return { id: `session-${++created}` };
      },
    });
    const error = await materializeCompositeGraph(
      plan,
      entityCaller,
      relationCaller,
      undefined,
      {
        planCallers: callers,
      }
    ).catch((err) => err);

    expect(error).toBeInstanceOf(CompositePlanApplyError);
    expect((error as CompositePlanApplyError).steps).toEqual([
      {
        opIndex: 3,
        ref: "s2",
        op: "create_session",
        reason: "session door exploded",
      },
    ]);
    // Nothing after the failed step ran: no edges, no document.
    expect(callers.linkCaller.create).not.toHaveBeenCalled();
    expect(callers.documentCaller.create).not.toHaveBeenCalled();
    // What HAD applied is exactly what compensation is handed.
    expect(callers.compensate).toHaveBeenCalledTimes(1);
    const applied = vi.mocked(callers.compensate).mock.calls[0][0];
    expect(applied.projects.map((p) => p.projectId)).toEqual(["project-1"]);
    expect(applied.entities.map((e) => e.entityId)).toEqual(["entity-Acme"]);
    expect(applied.sessions.map((s) => s.sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);
  });

  it("a REFUSED edge (the producer's owner floor) fails the plan too — never a partial structure", async () => {
    const { callers } = stubPlanCallers({
      linkCreate: async (input) => {
        if (input.type === "blocked_by")
          throw new Error("blocked_by refused (not_found)");
        return { linkId: "l", preExisting: false };
      },
    });
    const error = await materializeCompositeGraph(
      plan,
      entityCaller,
      relationCaller,
      undefined,
      {
        planCallers: callers,
      }
    ).catch((err) => err);
    expect(error).toBeInstanceOf(CompositePlanApplyError);
    expect((error as CompositePlanApplyError).steps[0]).toEqual(
      expect.objectContaining({ op: "create_link", opIndex: 0 })
    );
    // The refused blocker is the FIRST edge: every session had applied, no edge
    // had — and all three sessions reach compensation.
    const applied = vi.mocked(callers.compensate).mock.calls[0][0];
    expect(applied.links).toHaveLength(0);
    expect(applied.sessions).toHaveLength(3);
    expect(callers.documentCaller.create).not.toHaveBeenCalled();
  });

  it("inside a plan a failed RELATION is a failed plan (outside a plan it stays a reported skip)", async () => {
    const failingRelations = {
      create: vi.fn(async () => {
        throw new Error("Unknown relation type");
      }),
    };
    const graph: CompositeProposalOperation[] = [
      { op: "create_entity", ref: "a", profileSlug: "note", title: "A" },
      { op: "create_entity", ref: "b", profileSlug: "note", title: "B" },
      { op: "create_relation", sourceRef: "a", targetRef: "b", type: "nope" },
    ];

    // Non-plan: per-op resilience unchanged.
    const graphResult = await materializeCompositeGraph(
      graph,
      entityCaller,
      failingRelations
    );
    expect(graphResult.relationsFailed).toHaveLength(1);

    const { callers } = stubPlanCallers();
    const error = await materializeCompositeGraph(
      [...graph, { op: "create_session", ref: "s", goal: "g" }],
      entityCaller,
      failingRelations,
      undefined,
      { planCallers: callers }
    ).catch((err) => err);
    expect(error).toBeInstanceOf(CompositePlanApplyError);
    expect((error as CompositePlanApplyError).steps[0].op).toBe(
      "create_relation"
    );
    expect(callers.sessionCaller.create).not.toHaveBeenCalled();
  });

  it("a compensation that itself fails names every applied row as NOT compensated", async () => {
    const { callers } = stubPlanCallers({
      sessionCreate: async () => {
        throw new Error("boom");
      },
    });
    callers.compensate = vi.fn(async () => {
      throw new Error("undo engine down");
    });
    const error = (await materializeCompositeGraph(
      plan,
      entityCaller,
      relationCaller,
      undefined,
      {
        planCallers: callers,
      }
    ).catch((err) => err)) as CompositePlanApplyError;
    expect(error.compensation.notCompensated).toEqual(
      expect.arrayContaining([
        {
          kind: "project",
          id: "project-1",
          reason: "compensation failed: undo engine down",
        },
        {
          kind: "entity",
          id: "entity-Acme",
          reason: "compensation failed: undo engine down",
        },
      ])
    );
    expect(error.message).toMatch(/could not be rolled back/);
  });

  it("FAILS CLOSED: a plan op reaching a call site that wired no planCallers writes nothing", async () => {
    const creates = { create: vi.fn() };
    await expect(
      materializeCompositeGraph(plan, creates, relationCaller)
    ).rejects.toThrow(/wired no planCallers/);
    expect(creates.create).not.toHaveBeenCalled();
  });

  it("a REUSED project with a subject fails the step rather than retitling somebody's project", async () => {
    const { callers } = stubPlanCallers();
    callers.projectCaller.create = vi.fn(async () => ({
      id: "existing-project",
      linked: true,
    }));
    const error = await materializeCompositeGraph(
      plan,
      entityCaller,
      relationCaller,
      undefined,
      {
        planCallers: callers,
      }
    ).catch((err) => err);
    expect(error).toBeInstanceOf(CompositePlanApplyError);
    expect((error as CompositePlanApplyError).steps[0].reason).toMatch(
      /already exists .* rebind its subject/
    );
    expect(callers.projectCaller.setSubject).not.toHaveBeenCalled();
  });
});

/**
 * A plan's session carries the CRITERIA it proposes, not only its outputs.
 *
 * The founder's rule (2026-09-20): a session's definition of done may be
 * PROPOSED by the agent and validated or rewritten by the person. A plan is
 * the architecture its author is committing to, so it is exactly where those
 * statements are known — and before this, `materializeCompositeGraph` passed
 * `expectedOutputs` and silently dropped `criteria`, forcing a second
 * `update_session` round-trip the plan door exists to remove.
 *
 * The DISCRIMINATING pair is a step WITH criteria and a step WITHOUT: a
 * materializer that dropped the field entirely, and one that always sent `[]`,
 * agree on the second row and differ only on the first.
 */
describe("materializeCompositeGraph — a plan proposes the session's criteria", () => {
  const criteria = [
    {
      key: "schema-live",
      statement: "The two profiles are live on the pod",
      check: { kind: "human" },
    },
  ];

  it("carries criteria through to the session door, and sends [] when a step declares none", async () => {
    const seen: Array<{ goal: string; criteria: unknown }> = [];
    const { callers } = stubPlanCallers({
      sessionCreate: (async (input: { goal: string; criteria: unknown }) => {
        seen.push({ goal: input.goal, criteria: input.criteria });
        return { id: `session-${seen.length}`, linked: false };
      }) as unknown as PlanCallers["sessionCaller"]["create"],
    });

    await materializeCompositeGraph(
      [
        { op: "create_session", ref: "with", goal: "Build the pack", criteria },
        { op: "create_session", ref: "without", goal: "Plain session" },
      ] as CompositeProposalOperation[],
      entityCaller,
      relationCaller,
      undefined,
      { planCallers: callers }
    );

    expect(seen).toEqual([
      { goal: "Build the pack", criteria },
      // Absent is not malformed: the door reads an empty list as "none
      // proposed", never as a criteria set that failed to arrive.
      { goal: "Plain session", criteria: [] },
    ]);
  });
});

describe("materializeCompositeGraph — a plan step that waits is born planned (P4)", () => {
  it("tells the session door which steps wait (blockedByRefs or a blocked_by link), and carries startNow and the step's time", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { callers } = stubPlanCallers({
      sessionCreate: (async (input: Record<string, unknown>) => {
        seen.push(input);
        return { id: `session-${seen.length}`, linked: false };
      }) as unknown as PlanCallers["sessionCaller"]["create"],
    });

    await materializeCompositeGraph(
      [
        { op: "create_session", ref: "a", goal: "First" },
        {
          op: "create_session",
          ref: "b",
          goal: "Waits on a",
          blockedByRefs: ["a"],
          dueBy: "2027-03-31",
        },
        { op: "create_session", ref: "c", goal: "Linked later" },
        {
          op: "create_session",
          ref: "d",
          goal: "Waits but starts now",
          blockedByRefs: ["a"],
          startNow: true,
          plannedFor: "2027-03",
        },
        { op: "create_link", type: "blocked_by", fromRef: "c", toRef: "a" },
      ] as CompositeProposalOperation[],
      entityCaller,
      relationCaller,
      undefined,
      { planCallers: callers }
    );

    const byGoal = Object.fromEntries(
      seen.map((s) => [
        s.goal,
        {
          awaitsBlockers: s.awaitsBlockers,
          startNow: s.startNow,
          plannedFor: s.plannedFor,
          dueBy: s.dueBy,
        },
      ])
    );
    expect(byGoal).toEqual({
      // Rules out: "only blockedByRefs waits" (c waits through a link op) and
      // "a blocker of a waits too" (a is waited ON, it waits on nothing).
      First: {
        awaitsBlockers: undefined,
        startNow: undefined,
        plannedFor: undefined,
        dueBy: undefined,
      },
      "Waits on a": {
        awaitsBlockers: true,
        startNow: undefined,
        plannedFor: undefined,
        dueBy: "2027-03-31",
      },
      "Linked later": {
        awaitsBlockers: true,
        startNow: undefined,
        plannedFor: undefined,
        dueBy: undefined,
      },
      "Waits but starts now": {
        awaitsBlockers: true,
        startNow: true,
        plannedFor: "2027-03",
        dueBy: undefined,
      },
    });
  });
});

/**
 * THE ONE PLAN DOOR (pathway plan 368179d7, P7): a goal rides the same plan as
 * the sessions that join it.
 *
 * Pinned: goals apply parents-first BEFORE any session, so a session's
 * `trackRef` reaches the session door AT create (born in its goal, as
 * `start_session` + `trackId`); goal → goal edges run once every goal exists;
 * the record names the goals and the goal edges, so a failed plan hands both
 * to compensation.
 */
describe("materializeCompositeGraph — goals in the plan", () => {
  const onePlan: CompositeProposalOperation[] = [
    // Declared out of dependency order on purpose.
    {
      op: "create_session",
      ref: "step",
      goal: "Write the deck",
      trackRef: "seed",
    },
    {
      op: "create_track",
      ref: "seed",
      name: "Seed round",
      projectId: "project-x",
      parentRef: "company",
      blockedByRefs: ["preseed"],
    },
    {
      op: "create_track",
      ref: "preseed",
      name: "Pre-seed",
      projectId: "project-x",
    },
    {
      op: "create_track",
      ref: "company",
      name: "Fund Synap",
      projectId: "project-x",
    },
  ];

  it("goals parents-first before sessions, the session born in its goal", async () => {
    const { callers, calls } = stubPlanCallers();
    const entities = {
      create: vi.fn(async (input: { title: string }) => {
        calls.push(`entity:${input.title}`);
        return { id: `entity-${input.title}` };
      }),
    };
    const result = await materializeCompositeGraph(
      onePlan,
      entities,
      relationCaller,
      undefined,
      { planCallers: callers }
    );

    expect(calls).toEqual([
      // Its in-plan parent is started first and passed AT start.
      "track:Fund Synap:project=project-x:parent=null",
      "track:Seed round:project=project-x:parent=track-Fund Synap",
      "track:Pre-seed:project=project-x:parent=null",
      // Goal → goal edges once EVERY goal exists (the blocker came after).
      "track-blockers:track-Seed round>track-Pre-seed",
      "session:Write the deck:project=null:subject=null:track=track-Seed round",
    ]);
    expect(result.tracks?.map((t) => [t.ref, t.trackId])).toEqual([
      ["company", "track-Fund Synap"],
      ["seed", "track-Seed round"],
      ["preseed", "track-Pre-seed"],
    ]);
    // The record plan undo and the proposal stamp read.
    const { buildMaterializedRecord } =
      await import("../services/proposals/stamp-materialized.js");
    const record = buildMaterializedRecord(result);
    expect(record.trackIds).toEqual([
      "track-Fund Synap",
      "track-Seed round",
      "track-Pre-seed",
    ]);
    expect(record.linkIds).toContain("tl-track-Seed round-track-Pre-seed");
    expect(record.byOp?.seed).toEqual({
      op: "create_track",
      trackId: "track-Seed round",
    });
    expect(callers.compensate).not.toHaveBeenCalled();
  });

  it("a failed step after the goals hands them to compensation", async () => {
    const { callers } = stubPlanCallers({
      sessionCreate: async () => {
        throw new Error("session door exploded");
      },
    });
    const error = await materializeCompositeGraph(
      onePlan,
      entityCaller,
      relationCaller,
      undefined,
      { planCallers: callers }
    ).catch((err) => err);
    expect(error).toBeInstanceOf(CompositePlanApplyError);
    const applied = vi.mocked(callers.compensate).mock.calls[0][0];
    expect(applied.tracks?.map((t) => t.trackId).sort()).toEqual([
      "track-Fund Synap",
      "track-Pre-seed",
      "track-Seed round",
    ]);
    expect(
      applied.tracks?.find((t) => t.ref === "seed")?.blockerLinkIds
    ).toEqual(["tl-track-Seed round-track-Pre-seed"]);
  });

  it("a LIVE goal of the same name handed back is never placed or made to wait from the plan", async () => {
    const { callers } = stubPlanCallers({
      trackCreate: async (input) => ({
        id: `live-${input.name}`,
        linked: input.name === "Seed round",
      }),
    });
    const error = await materializeCompositeGraph(
      onePlan,
      entityCaller,
      relationCaller,
      undefined,
      { planCallers: callers }
    ).catch((err) => err);
    expect(error).toBeInstanceOf(CompositePlanApplyError);
    expect((error as CompositePlanApplyError).steps[0]).toEqual(
      expect.objectContaining({ op: "create_track", ref: "seed" })
    );
    expect((error as CompositePlanApplyError).steps[0].reason).toMatch(
      /already exists in this project/
    );
    expect(callers.trackCaller.addBlockers).not.toHaveBeenCalled();
    expect(callers.sessionCaller.create).not.toHaveBeenCalled();
    // Somebody's live goal is not this run's row: never compensated.
    const applied = vi.mocked(callers.compensate).mock.calls[0][0];
    const { buildMaterializedRecord } =
      await import("../services/proposals/stamp-materialized.js");
    expect(buildMaterializedRecord(applied).trackIds).not.toContain(
      "live-Seed round"
    );
  });
});

/**
 * A step waits on a DECISION or a GOAL, and a RE-PLAN edits existing steps
 * (pathway plan 368179d7, B3): one plan, applied whole.
 *
 * Pinned: re-plan edits on existing steps run before any edge is added; a
 * step → decision / goal edge runs after every session, goal and entity
 * exists (either may be created by the plan), through the cross-kind door,
 * never the session-to-session one; a failed plan hands the edits and the
 * new edges to compensation.
 */
describe("materializeCompositeGraph — cross-kind waits and re-plan edits", () => {
  const EXISTING = "9c1f2e3d-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
  const DECISION = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
  const OTHER = "0d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a";
  const replan: CompositeProposalOperation[] = [
    // Declared before what they point at, on purpose.
    {
      op: "create_link",
      type: "blocked_by",
      fromRef: "term",
      toEntityRef: "choice",
    },
    {
      op: "create_link",
      type: "blocked_by",
      fromRef: "term",
      toTrackRef: "seed",
    },
    {
      op: "create_link",
      type: "blocked_by",
      fromRef: "old",
      toEntityId: DECISION,
    },
    {
      op: "remove_link",
      type: "blocked_by",
      fromSessionId: EXISTING,
      toSessionId: OTHER,
    },
    {
      op: "update_session",
      ref: "old",
      sessionId: EXISTING,
      patch: { goal: "Pitch 10 funds", status: "paused" },
    },
    { op: "create_session", ref: "term", goal: "Term sheet" },
    {
      op: "create_entity",
      ref: "choice",
      profileSlug: "decision",
      title: "Lead investor",
    },
    { op: "create_track", ref: "seed", name: "Seed", projectId: "project-x" },
  ];

  it("waits on a decision and a goal after they exist, and edits existing steps", async () => {
    const { callers, calls } = stubPlanCallers();
    const result = await materializeCompositeGraph(
      replan,
      entityCaller,
      relationCaller,
      undefined,
      { planCallers: callers }
    );
    expect(calls).toEqual([
      "track:Seed:project=project-x:parent=null",
      "session:Term sheet:project=null:subject=null",
      // Re-plan edits BEFORE any edge is added (a reversed dependency drops
      // the old edge first).
      `update:${EXISTING}:{"goal":"Pitch 10 funds","status":"paused"}`,
      `unlink:${EXISTING}>session:${OTHER}`,
      // The cross-kind door, with the refs resolved — never the session door.
      "wait:session-1>entity:entity-Lead investor",
      "wait:session-1>track:track-Seed",
      // A link FROM a re-planned step names it by its update's ref.
      `wait:${EXISTING}>entity:${DECISION}`,
    ]);
    expect(callers.linkCaller.create).not.toHaveBeenCalled();
    const { buildMaterializedRecord } =
      await import("../services/proposals/stamp-materialized.js");
    const record = buildMaterializedRecord(result);
    expect(record.linkIds).toEqual(
      expect.arrayContaining([
        "xl-entity-Lead investor",
        "xl-track-Seed",
        `xl-${DECISION}`,
      ])
    );
    expect(record.byOp?.old).toEqual({
      op: "update_session",
      sessionId: EXISTING,
    });
  });

  it("a failed step hands the edits, the removals and the new edges to compensation", async () => {
    const { callers } = stubPlanCallers();
    callers.documentCaller.create = vi.fn(async () => {
      throw new Error("storage is down");
    });
    const error = await materializeCompositeGraph(
      [
        ...replan,
        {
          op: "create_document",
          ref: "memo",
          title: "Memo",
          content: "# Memo",
          sessionRef: "term",
        },
      ],
      entityCaller,
      relationCaller,
      undefined,
      { planCallers: callers }
    ).catch((err) => err);
    expect(error).toBeInstanceOf(CompositePlanApplyError);
    const applied = vi.mocked(callers.compensate).mock.calls[0][0];
    expect(applied.sessionUpdates?.map((u) => u.sessionId)).toEqual([EXISTING]);
    expect(applied.sessionUpdates?.[0].before.goal).toBe("old goal");
    expect(applied.linkRemovals).toEqual([
      expect.objectContaining({
        fromSessionId: EXISTING,
        toKind: "session",
        toId: OTHER,
        removed: true,
      }),
    ]);
    expect(applied.crossLinks).toHaveLength(3);
  });
});

describe("materializeCompositeGraph — a step that waits on a decision (cross-kind)", () => {
  const plan = [
    {
      op: "create_entity",
      ref: "pick",
      profileSlug: "decision",
      title: "Which lead investor",
      properties: {
        decisionOptions: [{ label: "Fund A" }, { label: "Fund B" }],
      },
    },
    { op: "create_session", ref: "term", goal: "Negotiate the term sheet" },
    {
      op: "create_link",
      type: "blocked_by",
      fromRef: "term",
      toEntityRef: "pick",
      option: "Fund A",
    },
  ] as CompositeProposalOperation[];

  it("a step whose ONLY blocker is a decision is born planned (awaitsBlockers), not active", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { callers } = stubPlanCallers({
      sessionCreate: (async (input: Record<string, unknown>) => {
        seen.push(input);
        return { id: "session-1", linked: false };
      }) as unknown as PlanCallers["sessionCaller"]["create"],
    });
    await materializeCompositeGraph(
      plan,
      entityCaller,
      relationCaller,
      undefined,
      {
        planCallers: callers,
      }
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].awaitsBlockers).toBe(true);
  });

  it("the arm option rides the edge to the governed door, once the decision exists", async () => {
    const { callers, calls } = stubPlanCallers();
    await materializeCompositeGraph(
      plan,
      entityCaller,
      relationCaller,
      undefined,
      {
        planCallers: callers,
      }
    );
    expect(calls.filter((c) => c.startsWith("wait:"))).toEqual([
      "wait:session-1>entity:entity-Which lead investor#Fund A",
    ]);
  });
});
