/**
 * The pure half of resolving one item of a stopped graph: which ops run,
 * which are left out, how the subset's handles are made absolute, and how
 * its record maps back onto the original keys.
 *
 * The graph is built so the two ref spaces DISAGREE: op 3 is a ref-less
 * entity after a relation, so its `byOp` key is `$op2` (the 3rd create_entity)
 * while a relation names it positionally as `$op3` (index among all ops).
 * Inside a subset, either positional name would point at the wrong op — a
 * resume that kept them would link the wrong records.
 */
import { describe, expect, it } from "vitest";
import {
  buildResumeOps,
  composeResolvedRecord,
  planResolveRun,
  remapRunRecord,
  ResolvePlanError,
  SKIPPED_BY_PERSON,
  SKIPPED_NEEDS_SKIPPED,
  waitingItems,
  type ResolvableRecord,
} from "./resolve-item-plan.js";
import { buildStoppedRunRecord, type LooseOp } from "./stamp-materialized.js";
import type { MaterializeResult } from "../../utils/materialize-composite.js";

const P1 = "11111111-1111-4111-8111-111111111111";

const OPS: LooseOp[] = [
  { op: "create_entity", ref: "p1", profileSlug: "pain-point", title: "P1" },
  { op: "create_entity", ref: "t", profileSlug: "trend", title: "T" },
  { op: "create_relation", sourceRef: "p1", targetRef: "t", type: "rel" },
  { op: "create_entity", profileSlug: "note", title: "N" },
  { op: "create_relation", sourceRef: "$op3", targetRef: "p1", type: "x" },
  {
    op: "create_relation",
    sourceRef: "$primary",
    targetRef: "$op3",
    type: "x",
  },
];

const RECORD: ResolvableRecord = {
  entityIds: [P1],
  byOp: { p1: { op: "create_entity", entityId: P1, linked: false } },
  opCount: 6,
  failedOp: {
    key: "t",
    opIndex: 1,
    op: "create_entity",
    title: "T",
    reason: "Couldn't file it",
    errorClass: "kind_missing",
  },
  notRun: [
    { key: "p1->t:rel", opIndex: 2, op: "create_relation" },
    { key: "$op2", opIndex: 3, op: "create_entity", title: "N" },
    { key: "$op3->p1:x", opIndex: 4, op: "create_relation" },
    { key: "$primary->$op3:x", opIndex: 5, op: "create_relation" },
  ],
  skipped: [],
};

describe("planResolveRun", () => {
  it("filing the item resumes it and everything that never ran", () => {
    const plan = planResolveRun({
      operations: OPS,
      record: RECORD,
      itemKey: "t",
      disposition: { kind: "file", targetWorkspaceId: "ws-eco" },
    });
    expect(plan.run).toEqual([1, 2, 3, 4, 5]);
    expect(plan.skip).toEqual([]);
    expect(plan.keepWaiting).toEqual([]);
    expect(plan.overrides).toEqual({ targetWorkspaceId: "ws-eco" });
  });

  it("skipping the item leaves out the links that need it, and resumes the rest", () => {
    const plan = planResolveRun({
      operations: OPS,
      record: RECORD,
      itemKey: "t",
      disposition: { kind: "skip" },
    });
    expect(plan.run).toEqual([3, 4, 5]);
    expect(plan.skip).toEqual([
      { opIndex: 1, reason: SKIPPED_BY_PERSON },
      { opIndex: 2, reason: SKIPPED_NEEDS_SKIPPED },
    ]);
  });

  it("holding the item keeps it and its links waiting", () => {
    const plan = planResolveRun({
      operations: OPS,
      record: RECORD,
      itemKey: "t",
      disposition: { kind: "hold", reviewProposalId: "rev-1" },
    });
    expect(plan.run).toEqual([3, 4, 5]);
    expect(plan.keepWaiting).toEqual([1, 2]);
  });

  it("refuses an item that is not waiting, and filing a link", () => {
    expect(() =>
      planResolveRun({
        operations: OPS,
        record: RECORD,
        itemKey: "p1",
        disposition: { kind: "skip" },
      })
    ).toThrow(ResolvePlanError);
    expect(() =>
      planResolveRun({
        operations: OPS,
        record: RECORD,
        itemKey: "p1->t:rel",
        disposition: { kind: "file" },
      })
    ).toThrow(/A link can only be skipped/);
  });

  it("refuses to resume a step it cannot resume", () => {
    const ops = [...OPS, { op: "create_skill", ref: "s1", name: "S" }];
    expect(() =>
      planResolveRun({
        operations: ops,
        record: {
          ...RECORD,
          opCount: 7,
          notRun: [
            ...RECORD.notRun!,
            { key: "s1", opIndex: 6, op: "create_skill" },
          ],
        },
        itemKey: "t",
        disposition: { kind: "skip" },
      })
    ).toThrow(/create_skill/);
  });
});

describe("buildResumeOps", () => {
  it("makes every handle absolute: landed ⇒ its id, in the run ⇒ @item<i>", () => {
    const resume = buildResumeOps({
      operations: OPS,
      run: [1, 2, 3, 4, 5],
      landed: new Map([[0, P1]]),
      overrides: new Map([[1, { targetWorkspaceId: "ws-eco" }]]),
    });
    expect(resume.operations).toEqual([
      expect.objectContaining({
        op: "create_entity",
        ref: "@item1",
        targetWorkspaceId: "ws-eco",
      }),
      expect.objectContaining({ sourceRef: P1, targetRef: "@item1" }),
      expect.objectContaining({ op: "create_entity", ref: "@item3" }),
      expect.objectContaining({ sourceRef: "@item3", targetRef: P1 }),
      // `$primary` is the first entity (p1, landed), never the subset's first.
      expect.objectContaining({ sourceRef: P1, targetRef: "@item3" }),
    ]);
    expect(resume.originalIndex).toEqual([1, 2, 3, 4, 5]);
    expect(Object.fromEntries(resume.originalKey)).toEqual({
      "@item1": "t",
      [`${P1}->@item1:rel`]: "p1->t:rel",
      "@item3": "$op2",
      [`@item3->${P1}:x`]: "$op3->p1:x",
      [`${P1}->@item3:x`]: "$primary->$op3:x",
    });
  });
});

describe("a resume's record, mapped back and composed", () => {
  it("skip: what the resume filed lands under the original keys and the receipt reads complete", () => {
    const plan = planResolveRun({
      operations: OPS,
      record: RECORD,
      itemKey: "t",
      disposition: { kind: "skip" },
    });
    const resume = buildResumeOps({
      operations: OPS,
      run: plan.run,
      landed: new Map([[0, P1]]),
    });
    // What the materializer returns for that subset (its own indexes, names).
    const result = {
      entities: [
        { ref: "@item3", opIndex: 0, entityId: "N-ID", linked: false },
      ],
      relations: [
        {
          requested: { sourceRef: "@item3", targetRef: P1, type: "x" },
          relationId: "r1",
        },
        {
          requested: { sourceRef: P1, targetRef: "@item3", type: "x" },
          relationId: "r2",
        },
      ],
      relationsFailed: [],
    } as unknown as MaterializeResult;
    const run = remapRunRecord(
      buildStoppedRunRecord(
        { operations: resume.operations, result, failedOpIndex: -1 },
        { reason: "", errorClass: "unknown" }
      ),
      resume
    );
    expect(Object.keys(run.byOp ?? {}).sort()).toEqual(
      ["$op2", "$op3->p1:x", "$primary->$op3:x"].sort()
    );
    expect(run.notRun).toEqual([]);

    const { record, complete } = composeResolvedRecord({
      older: RECORD,
      run,
      stopped: false,
      operations: OPS,
      plan,
      resolution: {
        key: "t",
        value: { action: "skip", outcome: "skipped", by: "u", at: "now" },
      },
      stampedAt: "now",
    });
    expect(complete).toBe(true);
    expect(record.opCount).toBeUndefined();
    expect(record.failedOp).toBeUndefined();
    expect(record.notRun).toBeUndefined();
    expect(record.byOp?.p1?.entityId).toBe(P1);
    expect(record.byOp?.$op2?.entityId).toBe("N-ID");
    expect(record.entityIds).toEqual([P1, "N-ID"]);
    expect(record.relationIds).toEqual(["r1", "r2"]);
    expect(record.skipped?.map((s) => s.key)).toEqual(["t", "p1->t:rel"]);
    expect(record.resolutions?.t?.outcome).toBe("skipped");
  });

  it("hold: the held item and its link stay waiting, the rest is filed", () => {
    const plan = planResolveRun({
      operations: OPS,
      record: RECORD,
      itemKey: "t",
      disposition: { kind: "hold", reviewProposalId: "rev-1" },
    });
    const { record, complete } = composeResolvedRecord({
      older: RECORD,
      run: { byOp: {} },
      stopped: false,
      operations: OPS,
      plan,
      resolution: {
        key: "t",
        value: {
          action: "widen_kind_scope",
          outcome: "held",
          by: "u",
          at: "now",
          reviewProposalId: "rev-1",
        },
      },
      stampedAt: "now",
    });
    expect(complete).toBe(false);
    expect(record.opCount).toBe(6);
    expect(record.failedOp).toBeUndefined();
    expect(record.notRun?.map((r) => r.key)).toEqual(["t", "p1->t:rel"]);
    const waiting = waitingItems(record);
    expect(waiting.map((w) => [w.key, w.state])).toEqual([
      ["t", "held"],
      ["p1->t:rel", "not_run"],
    ]);
    expect(waiting[0]!.reviewProposalId).toBe("rev-1");
  });
});
