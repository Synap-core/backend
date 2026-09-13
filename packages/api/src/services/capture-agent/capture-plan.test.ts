/**
 * A connected plan's PURE preflight: every structural problem at once.
 *
 * Fixture rows are chosen where a plausible wrong rule and the right rule
 * DISAGREE: a relation pointing at a SESSION ref (resolves fine as a ref, wrong
 * kind), a `spawned_from` whose child is an existing session (the producer
 * floors only the parent), two parents for one session, and cycles that close
 * only through in-plan refs.
 */

import { describe, expect, it } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  planSessionEdges,
  sessionOpsRootFirst,
  validatePlanOperations,
} from "./capture-plan.js";

const UUID = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";

const founderPlan: CompositeProposalOperation[] = [
  { op: "create_entity", ref: "acme", profileSlug: "company", title: "Acme" },
  {
    op: "create_project",
    ref: "p1",
    name: "Acme onboarding",
    subjectRef: "acme",
    evidenceRefs: ["acme"],
  },
  {
    op: "create_session",
    ref: "s0",
    title: "Onboard",
    goal: "Acme live",
    projectRef: "p1",
    subjectRef: "acme",
  },
  {
    op: "create_session",
    ref: "s1",
    goal: "Spec signed",
    parentRef: "s0",
    projectRef: "p1",
  },
  {
    op: "create_session",
    ref: "s2",
    goal: "Import done",
    parentRef: "s0",
    projectRef: "p1",
  },
  {
    op: "create_document",
    ref: "spec",
    title: "Spec",
    content: "# Spec",
    sessionRef: "s1",
  },
  { op: "create_link", type: "blocked_by", fromRef: "s2", toRef: "s1" },
];

const messages = (ops: CompositeProposalOperation[]) =>
  validatePlanOperations(ops).map((p) => p.message);

describe("validatePlanOperations", () => {
  it("accepts the founder's plan: project + root session + two children, one blocked, a spec document", () => {
    expect(validatePlanOperations(founderPlan)).toEqual([]);
  });

  it("refuses a ref of the WRONG kind, not just a missing ref", () => {
    const out = messages([
      ...founderPlan,
      {
        op: "create_relation",
        sourceRef: "acme",
        targetRef: "s0",
        type: "relates_to",
      },
      { op: "create_session", ref: "s3", goal: "x", projectRef: "acme" },
    ]);
    expect(out).toContain(
      'relation targetRef "s0" names a session — relations connect entities only'
    );
    expect(out).toContain(
      'projectRef "acme" names a entity, but must name a project'
    );
  });

  it("reports EVERY problem at once: unknown ref, both ref+id, over-long title, empty goal, bad UUID", () => {
    const out = messages([
      {
        op: "create_session",
        ref: "s1",
        title: "t".repeat(201),
        goal: "  ",
        parentRef: "nope",
        parentSessionId: UUID,
        blockedBySessionIds: ["not-a-uuid"],
      },
    ]);
    expect(out).toEqual(
      expect.arrayContaining([
        "a session step needs a `goal`",
        expect.stringMatching(/^title must be at most 200 characters/),
        "send parentRef OR parentSessionId, never both",
        'parentRef "nope" names no session in this plan',
        'blockedBySessionIds "not-a-uuid" is not a UUID',
      ])
    );
    expect(out.length).toBeGreaterThanOrEqual(5);
  });

  it("refuses a blocked_by cycle that closes only through in-plan refs", () => {
    const out = messages([
      { op: "create_session", ref: "a", goal: "a", blockedByRefs: ["b"] },
      { op: "create_session", ref: "b", goal: "b" },
      { op: "create_link", type: "blocked_by", fromRef: "b", toRef: "a" },
    ]);
    expect(out.some((m) => /^blocked_by cycle: /.test(m))).toBe(true);
  });

  it("refuses a parent cycle and a second parent", () => {
    const cycle = messages([
      { op: "create_session", ref: "a", goal: "a", parentRef: "b" },
      { op: "create_session", ref: "b", goal: "b", parentRef: "a" },
    ]);
    expect(cycle.some((m) => /^spawned_from cycle: /.test(m))).toBe(true);

    const twoParents = messages([
      { op: "create_session", ref: "a", goal: "a" },
      { op: "create_session", ref: "b", goal: "b" },
      { op: "create_session", ref: "c", goal: "c", parentRef: "a" },
      { op: "create_link", type: "spawned_from", fromRef: "c", toRef: "b" },
    ]);
    expect(twoParents.some((m) => /given 2 parents/.test(m))).toBe(true);
  });

  it("refuses re-parenting an EXISTING session and a link between two existing sessions", () => {
    const out = messages([
      { op: "create_session", ref: "a", goal: "a" },
      {
        op: "create_link",
        type: "spawned_from",
        fromSessionId: UUID,
        toRef: "a",
      },
      {
        op: "create_link",
        type: "blocked_by",
        fromSessionId: UUID,
        toSessionId: "8d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11",
      },
    ]);
    expect(
      out.some((m) =>
        /spawned_from link's `from` \(the child\) must be a session this plan creates/.test(
          m
        )
      )
    ).toBe(true);
    expect(
      out.some((m) => /must touch a session this plan creates/.test(m))
    ).toBe(true);
  });

  it("refuses a duplicate ref across kinds and an unknown link type", () => {
    const out = messages([
      { op: "create_entity", ref: "x", profileSlug: "note", title: "x" },
      { op: "create_session", ref: "x", goal: "g" },
      {
        op: "create_link",
        type: "depends_on" as never,
        fromRef: "x",
        toRef: "x",
      },
    ]);
    expect(out).toContain(
      'duplicate ref "x" — every ref must be unique across the whole plan'
    );
    expect(out.some((m) => /is not a plan edge/.test(m))).toBe(true);
  });
});

describe("plan edges and order", () => {
  it("derives parent, blocker and link edges from one list", () => {
    expect(
      planSessionEdges(founderPlan).map(
        (e) => `${e.type}:${JSON.stringify(e.from)}>${JSON.stringify(e.to)}`
      )
    ).toEqual([
      'spawned_from:{"ref":"s1"}>{"ref":"s0"}',
      'spawned_from:{"ref":"s2"}>{"ref":"s0"}',
      'blocked_by:{"ref":"s2"}>{"ref":"s1"}',
    ]);
  });

  it("orders sessions parents-first even when a child is declared before its parent", () => {
    const ops: CompositeProposalOperation[] = [
      { op: "create_session", ref: "child", goal: "c", parentRef: "root" },
      { op: "create_session", ref: "root", goal: "r" },
    ];
    expect(sessionOpsRootFirst(ops)).toEqual([1, 0]);
  });
});
