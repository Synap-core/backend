/**
 * `create_playbook` — the DRAFT-process composite op (capture → process,
 * 2026-10-08), end to end through every seam it touches EXCEPT the database:
 *
 *   validate (capture-plan) → govern (capture-graph-policy, strictest member)
 *   → materialize (pass 4, forced draft, per-op resilient, fail-closed when
 *   unwired) → executor caller (`buildRuleLoopCallers().playbookCaller` →
 *   `playbooks.create`, membership-floored) → receipt (`byOp`) → review render.
 *
 * Rows chosen where naive implementations DISAGREE: an op that asks for
 * `status: "active"` (must still land draft); a batch with an entity beside a
 * failing draft (the entity must survive); an unwired caller (must refuse
 * BEFORE the entity is written); a pod-wide batch (no workspace — a process
 * lives in a space).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  membership: { role: "owner" } as null | { role: string },
}));

vi.mock("../routers/playbooks.js", () => ({
  playbooksRouter: {
    createCaller: () => ({ create: h.create }),
  },
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getWorkspaceMembership: async () => h.membership };
});

import {
  isCompositeProposalData,
  type CompositeProposalOperation,
} from "@synap-core/types/proposals";
import {
  materializeCompositeGraph,
  type PlaybookCreateCaller,
} from "./materialize-composite.js";
import { buildRuleLoopCallers } from "./rule-loop-callers.js";
import { captureGraphEventKeys } from "../services/capture-agent/capture-graph-policy.js";
import { validatePlanOperations } from "../services/capture-agent/capture-plan.js";
import { buildMaterializedRecord } from "../services/proposals/stamp-materialized.js";
import { buildProposalGraph } from "../routers/proposals/display.js";
import { buildDraftProcessOp } from "../services/capture-agent/draft-process.js";

const draft = buildDraftProcessOp({
  profileSlug: "track",
  statusProperty: "track-status",
});
const op = { op: "create_playbook" as const, ...draft };

beforeEach(() => {
  h.create.mockReset();
  h.membership = { role: "owner" };
});

describe("create_playbook — the op", () => {
  it("is a recognised composite, validates, and governs as playbook.create", () => {
    expect(isCompositeProposalData({ operations: [op] } as never)).toBe(true);
    expect(validatePlanOperations([op])).toEqual([]);
    expect(captureGraphEventKeys([op])).toEqual([
      { subjectType: "playbook", action: "create" },
    ]);
  });

  it("refuses a draft with no kind, or one that is not a draft", () => {
    const bad = [
      { ...op, subjectProfile: { profileSlug: "" } },
      { ...op, ref: "pb2", status: "active" },
    ] as unknown as CompositeProposalOperation[];
    const problems = validatePlanOperations(bad);
    expect(problems.map((p) => p.opIndex)).toEqual([0, 1]);
  });

  it("draft builder: minimal goal, the kind and its lifecycle property", () => {
    expect(draft).toMatchObject({
      ref: "draft_process",
      status: "draft",
      subjectProfile: { profileSlug: "track", statusProperty: "track-status" },
    });
    expect(draft.goalTemplate.length).toBeGreaterThan(0);
  });
});

describe("create_playbook — materializer pass", () => {
  const entityCaller = { create: vi.fn() };
  const relationCaller = { create: vi.fn() };

  it("creates the playbook as a DRAFT even when the op asks for active", async () => {
    const playbookCaller: PlaybookCreateCaller = {
      create: vi.fn().mockResolvedValue({ id: "pb-1" }),
    };
    const result = await materializeCompositeGraph(
      [{ ...op, status: "active" } as unknown as CompositeProposalOperation],
      entityCaller,
      relationCaller,
      undefined,
      { playbookCaller }
    );
    expect(playbookCaller.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "draft",
        subjectProfile: {
          profileSlug: "track",
          statusProperty: "track-status",
        },
      })
    );
    expect(result.playbooks).toEqual([
      { ref: "draft_process", opIndex: 0, playbookId: "pb-1", status: "draft" },
    ]);
    expect(result.refToRealId.draft_process).toBe("pb-1");
    // The receipt names it, so an undo of ONE item can find it.
    expect(buildMaterializedRecord(result).byOp?.draft_process).toEqual({
      op: "create_playbook",
      playbookId: "pb-1",
    });
  });

  it("FAILS CLOSED when no playbookCaller is wired — before any write", async () => {
    const ec = { create: vi.fn().mockResolvedValue({ entity: { id: "e1" } }) };
    await expect(
      materializeCompositeGraph(
        [{ op: "create_entity", profileSlug: "track", title: "Strobe" }, op],
        ec,
        relationCaller,
        undefined,
        {}
      )
    ).rejects.toThrow(/create_playbook/);
    expect(ec.create).not.toHaveBeenCalled();
  });

  it("a failing draft never discards the entity captured beside it", async () => {
    const ec = {
      create: vi.fn().mockResolvedValue({ entity: { id: "e1" }, id: "e1" }),
    };
    const playbookCaller: PlaybookCreateCaller = {
      create: vi.fn().mockRejectedValue(new Error("name taken")),
    };
    const result = await materializeCompositeGraph(
      [{ op: "create_entity", profileSlug: "track", title: "Strobe" }, op],
      ec,
      relationCaller,
      undefined,
      { playbookCaller }
    );
    expect(ec.create).toHaveBeenCalledTimes(1);
    expect(result.playbooks).toEqual([]);
  });
});

describe("create_playbook — executor caller (playbooks.create door)", () => {
  const ctx = {
    database: {} as never,
    userId: "user-1",
    workspaceId: "ws-1",
    auditSource: "test",
  };

  it("routes through playbooks.create with status draft", async () => {
    h.create.mockResolvedValue({
      status: "created",
      playbook: { id: "pb-9" },
    });
    const { playbookCaller } = buildRuleLoopCallers(ctx);
    const out = await playbookCaller.create({
      name: draft.name,
      goalTemplate: draft.goalTemplate,
      subjectProfile: draft.subjectProfile,
      status: "draft",
    });
    expect(out).toEqual({ id: "pb-9" });
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "draft",
        subjectProfile: draft.subjectProfile,
      })
    );
  });

  it("refuses a pod-wide draft and a non-member, and never reports a proposal as created", async () => {
    await expect(
      buildRuleLoopCallers({ ...ctx, workspaceId: null }).playbookCaller.create(
        { ...draft, status: "draft" }
      )
    ).rejects.toThrow(/workspace/);
    h.membership = null;
    await expect(
      buildRuleLoopCallers(ctx).playbookCaller.create({
        ...draft,
        status: "draft",
      })
    ).rejects.toThrow(/access/);
    h.membership = { role: "owner" };
    h.create.mockResolvedValue({ status: "proposed", playbook: null });
    await expect(
      buildRuleLoopCallers(ctx).playbookCaller.create({
        ...draft,
        status: "draft",
      })
    ).rejects.toThrow(/did not apply/);
  });
});

describe("create_playbook — review render", () => {
  it("renders (the unrendered-op guard would otherwise refuse the proposal)", () => {
    const graph = buildProposalGraph({ operations: [op] } as never);
    expect(graph.playbooks).toEqual([
      expect.objectContaining({
        ref: "draft_process",
        subjectProfileSlug: "track",
        statusProperty: "track-status",
        bornStatus: "draft",
      }),
    ]);
  });
});
