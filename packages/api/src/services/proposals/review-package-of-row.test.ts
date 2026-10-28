/**
 * A stored proposal row → its review package, and a cluster's package
 * (founder B-1). The classifier's own rules are pinned in
 * `@synap-core/types` (`review-package.test.ts`); this pins what the pod adds:
 * the class it reads, the create kind off the payload, a person author, and
 * the cluster's highest-stakes member.
 */
import { describe, expect, it } from "vitest";
import {
  reviewPackageOfRow,
  reviewPackageOfRows,
} from "./review-package-of-row.js";
import {
  collapseProposalsToClusters,
  type ClusterInputRow,
} from "./fingerprint.js";

const AGENT = "agent-1";

function row(over: Partial<ClusterInputRow> = {}): ClusterInputRow {
  return {
    id: over.id ?? "p-1",
    proposalType: "update",
    targetType: "focus_session",
    targetId: "s-1",
    data: null,
    createdAt: new Date("2026-10-27T19:00:00Z"),
    workspaceId: null,
    agentUserId: AGENT,
    sessionId: "s-1",
    ...over,
  };
}

describe("reviewPackageOfRow", () => {
  it("an agent's own session update is bookkeeping; a person's is a data change", () => {
    expect(reviewPackageOfRow(row())).toBe("bookkeeping");
    expect(reviewPackageOfRow(row({ agentUserId: null }))).toBe("data-changes");
  });

  it("reads the create's kind off the request envelope", () => {
    const create = (profileSlug: string) =>
      reviewPackageOfRow(
        row({
          proposalType: "create",
          targetType: "entity",
          data: { data: { profileSlug, title: "x" } },
        })
      );
    expect(create("knowledge")).toBe("knowledge");
    expect(create("company")).toBe("data-changes");
  });

  it("reads the pod's class: a workspace join is access", () => {
    expect(
      reviewPackageOfRow(row({ proposalType: "join", targetType: "workspace" }))
    ).toBe("access");
  });

  it("a held-writes pack files by its writes", () => {
    const write = (subjectType: string, action: string) => ({
      ref: `${subjectType}.${action}`,
      subjectType,
      action,
      data: {},
      sessionId: null,
      agentUserId: AGENT,
      userId: "u",
      at: "2026-10-27T19:00:00Z",
      fingerprint: "f",
    });
    expect(
      reviewPackageOfRow(
        row({
          proposalType: "held_writes",
          targetType: "agent",
          data: { deferredWrites: [write("focus_session", "update")] },
        })
      )
    ).toBe("bookkeeping");
    expect(
      reviewPackageOfRow(
        row({
          proposalType: "held_writes",
          targetType: "agent",
          data: {
            deferredWrites: [
              write("focus_session", "update"),
              write("skill", "update"),
            ],
          },
        })
      )
    ).toBe("how-things-work");
  });
});

describe("a cluster's package is its highest-stakes member's", () => {
  it("one person-filed member lifts an agent's bookkeeping cluster", () => {
    expect(reviewPackageOfRows([row(), row({ agentUserId: null })])).toBe(
      "data-changes"
    );
  });

  it("collapse stamps it on every cluster", () => {
    const clusters = collapseProposalsToClusters([
      row({ id: "a" }),
      row({ id: "b", createdAt: new Date("2026-10-27T19:01:00Z") }),
      row({
        id: "c",
        proposalType: "assign_agent",
        targetId: "s-2",
        sessionId: "s-2",
      }),
    ]);
    const byType = Object.fromEntries(
      clusters.map((c) => [c.proposalType, c.package])
    );
    expect(byType).toEqual({
      update: "bookkeeping",
      assign_agent: "hand-offs",
    });
  });

  it("a mixed cluster takes the higher package whatever the member order", () => {
    const [cluster] = collapseProposalsToClusters([
      row({ id: "a" }),
      row({ id: "b", agentUserId: null }),
    ]);
    expect(cluster?.package).toBe("data-changes");
    const [reversed] = collapseProposalsToClusters([
      row({ id: "b", agentUserId: null }),
      row({ id: "a" }),
    ]);
    expect(reversed?.package).toBe("data-changes");
  });
});
