/**
 * `humanizeTarget` for a "connection" rule reads `targetPattern` as a
 * connection-registry row id (`registryConnectionId`), never the broker's
 * own `connectionId` (accountHint) — those are two different ids on the same
 * `connectors.allConnections` row (see connectors-trpc.ts's header comment).
 * Keying the lookup on the wrong one makes every connection rule read
 * "A connection" while typechecking clean.
 */

import { describe, expect, it } from "vitest";
import {
  buildConnectionLabelLookup,
  humanizePrincipal,
  humanizeScope,
  humanizeTarget,
  provenanceLabel,
  type GovernanceRuleRow,
} from "./rule-view-model";

// Shaped exactly like one row of `trpc.connectors.allConnections`.
const allConnectionsRow = {
  connectionId: "broker-account-hint-abc", // the broker's own id
  registryConnectionId: "reg-row-1", // the id rules actually target
  providerId: "google-calendar",
  workspaceId: null,
  workspaceName: null,
  accountEmail: null,
  status: "active" as const,
  lastSyncedAt: null,
  createdAt: new Date(),
};

/** The real lookup `governance-rules-panel.tsx` builds from that row list. */
function connectionLabelFrom(rows: (typeof allConnectionsRow)[]) {
  return buildConnectionLabelLookup(rows);
}

function connectionRule(targetPattern: string): GovernanceRuleRow {
  return {
    id: "rule-1",
    targetKind: "connection",
    targetPattern,
    targetProfile: null,
  } as GovernanceRuleRow;
}

describe("humanizeTarget — connection rules key on registryConnectionId", () => {
  it("resolves a real label when the rule targets the registry row id", () => {
    const connectionLabel = connectionLabelFrom([allConnectionsRow]);
    expect(
      humanizeTarget(connectionRule("reg-row-1"), { connectionLabel })
    ).toBe("Keep syncing · Google calendar");
  });

  it("does NOT resolve when targeting the broker's connectionId instead", () => {
    const connectionLabel = connectionLabelFrom([allConnectionsRow]);
    expect(
      humanizeTarget(connectionRule("broker-account-hint-abc"), {
        connectionLabel,
      })
    ).toBe("A connection");
  });

  it("falls back to 'A connection' when no lookup is given", () => {
    expect(humanizeTarget(connectionRule("reg-row-1"))).toBe("A connection");
  });
});

/**
 * The rules list reads the shared rule words (`@synap-core/types/governance-rules`),
 * not a pod-admin copy: that copy had no `class` principal, so a rule "for all
 * computers" read "Any agent" here while the desktop said "All computers".
 */
describe("the rules list reads the shared words", () => {
  // Shaped like one `governanceRules.list` row of a "for all computers" rule.
  const computersRule = {
    id: "rule-2",
    principalKind: "class",
    principalClass: "machine",
    agentUserId: null,
    agentLabel: null,
    scopeKind: "workspace",
    workspaceId: "ws-1",
    targetKind: "action",
    targetPattern: "*",
    targetProfile: null,
    verdict: "auto",
    createdAt: new Date(),
    createdBy: "user-1",
    sourceProposalId: null,
    expiresAt: null,
  } satisfies GovernanceRuleRow;

  it('a class (computers) rule reads "All computers"', () => {
    expect(humanizePrincipal(computersRule)).toBe("All computers");
  });

  it('a rule set directly reads "Standing override" in "This space"', () => {
    expect(provenanceLabel(computersRule)).toBe("Standing override");
    expect(humanizeScope(computersRule)).toBe("This space");
  });
});
