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
              `session:${input.goal}:project=${input.projectId}:subject=${input.subjectEntityId}`
            );
            return { id: `session-${++n}` };
          })
      ),
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
    },
    documentCaller: {
      create: vi.fn(async (input) => {
        calls.push(`document:${input.title}:session=${input.sessionId}`);
        return { id: "doc-1" };
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
