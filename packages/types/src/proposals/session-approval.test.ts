import { describe, expect, it } from "vitest";
import {
  sessionApprovalOrder,
  sessionApprovalRank,
} from "./session-approval.js";

const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m));

describe("sessionApprovalOrder — what a later item needs, first", () => {
  it("space, kind, lifecycle, playbook, automation, rule, then the rest", () => {
    const rows = [
      {
        id: "rule",
        targetType: "rule",
        proposalType: "create",
        createdAt: at(0),
      },
      {
        id: "note",
        targetType: "entity",
        proposalType: "create",
        createdAt: at(1),
      },
      {
        id: "auto",
        targetType: "automation",
        proposalType: "create",
        createdAt: at(2),
      },
      {
        id: "pb",
        targetType: "playbook",
        proposalType: "create",
        createdAt: at(3),
      },
      {
        id: "lc",
        targetType: "profile",
        proposalType: "declare_lifecycle",
        createdAt: at(4),
      },
      {
        id: "kind",
        targetType: "profile",
        proposalType: "create",
        createdAt: at(5),
      },
      {
        id: "space",
        targetType: "workspace",
        proposalType: "create",
        createdAt: at(6),
      },
    ];
    expect(sessionApprovalOrder(rows).map((r) => r.id)).toEqual([
      "space",
      "kind",
      "lc",
      "pb",
      "auto",
      "rule",
      "note",
    ]);
  });

  it("a plan takes the rank of its earliest step; equal ranks keep the filing order", () => {
    const plan = {
      id: "plan",
      targetType: "composite",
      createdAt: at(9),
      data: {
        operations: [
          {
            op: "create_automation",
            ref: "a",
            name: "A",
            triggerType: "manual",
            flowDefinition: {},
          },
          { op: "create_workspace", ref: "w", name: "W" },
        ],
      },
    };
    expect(sessionApprovalRank(plan)).toBe(0);
    const rows = [
      {
        id: "late-space",
        targetType: "workspace",
        proposalType: "create",
        createdAt: at(8),
      },
      plan,
      {
        id: "early-space",
        targetType: "workspace",
        proposalType: "create",
        createdAt: at(1),
      },
    ];
    expect(sessionApprovalOrder(rows).map((r) => r.id)).toEqual([
      "early-space",
      "late-space",
      "plan",
    ]);
  });
});
