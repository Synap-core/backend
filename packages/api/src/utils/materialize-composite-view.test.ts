/**
 * `create_view` — a List filed in the SAME governed bundle as the things it
 * lists (import Build, 2026-10-12), through every seam it touches except the
 * database (the undo half runs on Postgres in
 * `bundle-config-revert.pglite.test.ts`):
 *
 *   validate (capture-plan) → govern (capture-graph-policy) → materialize
 *   (pass 5, after entities, refs resolved, per-op resilient, fail-closed when
 *   unwired) → executor caller (`buildRuleLoopCallers().viewCaller` →
 *   `views.create`, fixed set + container on config) → receipt (`byOp`,
 *   `viewIds`) → review render.
 *
 * Rows chosen where naive implementations DISAGREE: members named by in-batch
 * ref (must reach the door as REAL ids); a list with neither kinds nor members
 * (refused at propose time, not at apply); a list that fails beside a thing
 * (the thing survives); an unwired caller (refuses BEFORE any write); a list
 * with no named kinds (kinds come from its members).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  membership: { role: "owner" } as null | { role: string },
  profiles: new Map<string, string>([["note", "prof-note"]]),
}));

vi.mock("../routers/views.js", () => ({
  viewsRouter: { createCaller: () => ({ create: h.create }) },
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getWorkspaceMembership: async () => h.membership,
    ProfileResolutionService: class {
      async resolveProfile(slug: string) {
        const id = h.profiles.get(slug);
        return id ? { id } : null;
      }
    },
  };
});

import {
  isCompositeProposalData,
  type CompositeProposalOperation,
} from "@synap-core/types/proposals";
import {
  materializeCompositeGraph,
  type ViewCreateCaller,
} from "./materialize-composite.js";
import { buildRuleLoopCallers } from "./rule-loop-callers.js";
import { captureGraphEventKeys } from "../services/capture-agent/capture-graph-policy.js";
import { validatePlanOperations } from "../services/capture-agent/capture-plan.js";
import { buildMaterializedRecord } from "../services/proposals/stamp-materialized.js";
import { buildProposalGraph } from "../routers/proposals/display.js";

const thing = {
  op: "create_entity" as const,
  ref: "t1",
  profileSlug: "note",
  title: "Recipe",
};
const container = {
  op: "create_entity" as const,
  ref: "g1",
  profileSlug: "note",
  title: "Cooking",
};
const list = {
  op: "create_view" as const,
  ref: "list1",
  name: "Cooking",
  viewType: "list" as const,
  entityRefs: ["t1"],
  containerRef: "g1",
};

beforeEach(() => {
  h.create.mockReset();
  h.membership = { role: "owner" };
});

describe("create_view — the op", () => {
  it("is a recognised composite, validates, and governs as view.create", () => {
    const ops = [thing, container, list] as CompositeProposalOperation[];
    expect(isCompositeProposalData({ operations: ops } as never)).toBe(true);
    expect(validatePlanOperations(ops, { workspaceId: null })).toEqual([]);
    expect(captureGraphEventKeys([list])).toEqual([
      { subjectType: "view", action: "create" },
    ]);
  });

  it("refuses a list that names neither kinds nor things, a bad type, and a dangling member", () => {
    const bad = [
      thing,
      { ...list, ref: "l2", entityRefs: [], containerRef: undefined },
      { ...list, ref: "l3", viewType: "whiteboard" },
      { ...list, ref: "l4", entityRefs: ["nope"] },
      container,
    ] as unknown as CompositeProposalOperation[];
    const problems = validatePlanOperations(bad);
    expect(problems.map((p) => p.opIndex)).toEqual([1, 2, 3]);
    expect(problems[0]!.message).toMatch(/scopeProfileSlugs.*entityRefs/);
    expect(problems[2]!.message).toMatch(/"nope" names no entity/);
  });
});

describe("create_view — materializer pass", () => {
  const relationCaller = { create: vi.fn() };
  const entityCaller = () => {
    let n = 0;
    return {
      create: vi.fn(async () => {
        n += 1;
        return { status: "created", id: `e${n}` };
      }),
    };
  };

  it("runs after the entities and hands the door REAL ids, not refs", async () => {
    const viewCaller: ViewCreateCaller = {
      create: vi.fn().mockResolvedValue({ id: "v-1" }),
    };
    const result = await materializeCompositeGraph(
      // The list comes FIRST in the array: apply order is the passes', not
      // the array's.
      [list, thing, container] as CompositeProposalOperation[],
      entityCaller(),
      relationCaller,
      undefined,
      { viewCaller }
    );
    expect(viewCaller.create).toHaveBeenCalledWith({
      name: "Cooking",
      viewType: "list",
      entityIds: ["e1"],
      containerEntityId: "e2",
    });
    expect(result.views).toEqual([
      {
        ref: "list1",
        opIndex: 0,
        viewId: "v-1",
        entityIds: ["e1"],
        containerEntityId: "e2",
      },
    ]);
    const record = buildMaterializedRecord(result);
    expect(record.viewIds).toEqual(["v-1"]);
    expect(record.byOp?.list1).toEqual({ op: "create_view", viewId: "v-1" });
  });

  it("FAILS CLOSED when no viewCaller is wired — before any write", async () => {
    const ec = entityCaller();
    await expect(
      materializeCompositeGraph(
        [thing, list] as CompositeProposalOperation[],
        ec,
        relationCaller,
        undefined,
        {}
      )
    ).rejects.toThrow(/create_view/);
    expect(ec.create).not.toHaveBeenCalled();
  });

  it("a failing list never discards the thing captured beside it", async () => {
    const ec = entityCaller();
    const result = await materializeCompositeGraph(
      [
        thing,
        { ...list, containerRef: undefined },
      ] as CompositeProposalOperation[],
      ec,
      relationCaller,
      undefined,
      { viewCaller: { create: vi.fn().mockRejectedValue(new Error("boom")) } }
    );
    expect(result.entities.map((e) => e.entityId)).toEqual(["e1"]);
    expect(result.views).toEqual([]);
  });
});

describe("create_view — executor caller (views.create door)", () => {
  /** Answers the members' kind lookup the way drizzle would. */
  const databaseWithKinds = (profileIds: Array<string | null>) =>
    ({
      select: () => ({
        from: () => ({
          where: async () => profileIds.map((profileId) => ({ profileId })),
        }),
      }),
    }) as never;
  const ctx = {
    database: databaseWithKinds(["prof-note", "prof-note"]),
    userId: "user-1",
    workspaceId: "ws-1",
    auditSource: "test",
  };

  it("creates a fixed-set list scoped to its members' kinds, container on the config", async () => {
    h.create.mockResolvedValue({ status: "created", view: { id: "v-9" } });
    const out = await buildRuleLoopCallers(ctx).viewCaller.create({
      name: "Cooking",
      viewType: "list",
      entityIds: ["e1", "e2"],
      containerEntityId: "g1",
    });
    expect(out).toEqual({ id: "v-9" });
    expect(h.create).toHaveBeenCalledWith({
      name: "Cooking",
      type: "list",
      workspaceId: "ws-1",
      scopeProfileIds: ["prof-note"],
      query: { entityIds: ["e1", "e2"] },
      config: { membersOf: "g1" },
    });
  });

  it("named kinds win over the members' kinds; an unknown kind is refused by name", async () => {
    h.create.mockResolvedValue({ status: "created", view: { id: "v-9" } });
    await buildRuleLoopCallers(ctx).viewCaller.create({
      name: "Notes",
      viewType: "table",
      scopeProfileSlugs: ["note"],
      entityIds: [],
    });
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ scopeProfileIds: ["prof-note"] })
    );
    expect(h.create.mock.calls[0]![0]).not.toHaveProperty("query");
    await expect(
      buildRuleLoopCallers(ctx).viewCaller.create({
        name: "Ghosts",
        viewType: "list",
        scopeProfileSlugs: ["ghost"],
        entityIds: [],
      })
    ).rejects.toThrow(/no kind "ghost"/);
  });

  it("refuses a non-member, and never reports a proposed view as created", async () => {
    h.membership = null;
    await expect(
      buildRuleLoopCallers(ctx).viewCaller.create({
        name: "Cooking",
        viewType: "list",
        entityIds: ["e1"],
      })
    ).rejects.toThrow(/access/);
    h.membership = { role: "owner" };
    h.create.mockResolvedValue({ status: "proposed", view: null });
    await expect(
      buildRuleLoopCallers(ctx).viewCaller.create({
        name: "Cooking",
        viewType: "list",
        entityIds: ["e1"],
      })
    ).rejects.toThrow(/did not apply/);
  });
});

describe("create_view — review render", () => {
  it("renders (the unrendered-op guard would otherwise refuse the proposal)", () => {
    const graph = buildProposalGraph({
      operations: [thing, container, list],
    } as never);
    expect(graph.views).toEqual([
      {
        ref: "list1",
        name: "Cooking",
        viewType: "list",
        memberCount: 1,
        containerRef: "g1",
      },
    ]);
  });
});
