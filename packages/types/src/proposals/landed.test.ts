import { describe, expect, it } from "vitest";
import {
  landedFromRecord,
  landedRoleOf,
  proposalLanded,
  proposalObjectsOf,
} from "./landed.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

describe("proposalLanded — the stamp, else the records, else the target", () => {
  it("reads the stamp the approval tail writes, and only it", () => {
    expect(
      proposalLanded({
        status: "approved",
        targetType: "entity",
        targetId: D,
        data: {
          landed: [
            { kind: "automation", id: A, role: "created" },
            { kind: "not-a-kind", id: B, role: "created" },
            { kind: "entity", id: "not-a-uuid", role: "created" },
          ],
          materialized: { entityIds: [C] },
        },
      })
    ).toEqual([{ kind: "automation", id: A, role: "created" }]);
  });

  it("an empty stamp says nothing landed: the target is not guessed", () => {
    expect(
      proposalLanded({
        status: "approved",
        proposalType: "update",
        targetType: "entity",
        targetId: D,
        data: { landed: [] },
      })
    ).toEqual([]);
  });

  it("reads an old row from what its apply recorded", () => {
    expect(
      landedFromRecord({
        materialized: {
          entityIds: [A],
          automationIds: [B],
          ruleIds: [C],
          byOp: {
            $op0: { op: "create_entity", entityId: A, linked: false },
            lead: { op: "create_entity", entityId: D, linked: true },
          },
          rowPatches: [{ kind: "focus_session", id: B, before: {}, after: {} }],
          relationIds: [C],
        },
      })
    ).toEqual([
      { kind: "entity", id: A, role: "created" },
      { kind: "automation", id: B, role: "created" },
      { kind: "skill", id: C, role: "created" },
      { kind: "entity", id: D, role: "linked" },
      { kind: "session", id: B, role: "updated" },
    ]);
  });

  it("a playbook run landed the sessions it started, never its playbook", () => {
    const row = {
      status: "approved",
      proposalType: "run",
      targetType: "playbook",
      targetId: D,
      data: { runResult: { started: [{ sessionId: A }, { sessionId: B }] } },
    };
    expect(proposalLanded(row)).toEqual([
      { kind: "session", id: A, role: "created" },
      { kind: "session", id: B, role: "created" },
    ]);
    expect(proposalLanded({ ...row, data: {} })).toEqual([]);
  });

  it("falls back to the target, with the role its verb gives", () => {
    expect(
      proposalLanded({
        status: "auto_approved",
        proposalType: "entity.create",
        targetType: "entity",
        targetId: A,
        data: {},
      })
    ).toEqual([{ kind: "entity", id: A, role: "created" }]);
    expect(
      proposalLanded({
        status: "approved",
        proposalType: "activate",
        targetType: "automation",
        targetId: A,
        data: {},
      })
    ).toEqual([{ kind: "automation", id: A, role: "updated" }]);
    expect(
      proposalLanded({
        status: "approved",
        proposalType: "delete",
        targetType: "entity",
        targetId: A,
        data: {},
      })
    ).toEqual([]);
  });

  it("an undecided or refused row landed nothing", () => {
    for (const status of ["pending", "rejected", "approval_failed"]) {
      expect(
        proposalLanded({
          status,
          targetType: "entity",
          targetId: A,
          data: { landed: [{ kind: "entity", id: A, role: "created" }] },
        })
      ).toEqual([]);
    }
  });
});

describe("proposalObjectsOf — landed first, intent second", () => {
  it("an undecided update names the object it changes, with no role", () => {
    expect(
      proposalObjectsOf({
        status: "pending",
        proposalType: "update",
        targetType: "focus_session",
        targetId: A,
      })
    ).toEqual([{ kind: "session", id: A, role: null }]);
  });

  it("names nothing where the target is no object", () => {
    const none = [
      { status: "pending", proposalType: "create", targetType: "entity", targetId: A },
      { status: "pending", proposalType: "run", targetType: "playbook", targetId: A },
      {
        status: "approved",
        proposalType: "capture.graph",
        targetType: "entity",
        targetId: A,
        data: {},
      },
      {
        status: "pending",
        proposalType: "create",
        targetType: "entity",
        targetId: A,
        data: { operations: [{ op: "create_entity" }] },
      },
      { status: "pending", proposalType: "update", targetType: "relation", targetId: A },
    ];
    for (const row of none) expect(proposalObjectsOf(row)).toEqual([]);
  });

  it("a merge names its survivor, a facet its entity", () => {
    expect(
      proposalObjectsOf({
        status: "pending",
        proposalType: "merge",
        targetType: "entity",
        targetId: B,
        data: { winnerId: A, loserId: B },
      })
    ).toEqual([{ kind: "entity", id: A, role: null }]);
    expect(
      proposalObjectsOf({
        status: "pending",
        proposalType: "attach",
        targetType: "facet",
        targetId: B,
        data: { data: { entityId: A } },
      })
    ).toEqual([{ kind: "entity", id: A, role: null }]);
  });

  it("an applied row names what it landed", () => {
    expect(
      proposalObjectsOf({
        status: "approved",
        proposalType: "create",
        targetType: "entity",
        targetId: D,
        data: { landed: [{ kind: "automation", id: A, role: "created" }] },
      })
    ).toEqual([{ kind: "automation", id: A, role: "created" }]);
  });
});

describe("landedRoleOf", () => {
  it("creates, removes, or updates by the one verb reading", () => {
    expect(landedRoleOf({ proposalType: "focus_session.create" })).toBe("created");
    expect(landedRoleOf({ proposalType: "run" })).toBe("created");
    expect(landedRoleOf({ proposalType: "entity.delete" })).toBeNull();
    expect(landedRoleOf({ proposalType: "activate" })).toBe("updated");
  });
});
