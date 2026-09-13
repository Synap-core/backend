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
  humanizeTarget,
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
    ).toBe("Connection · Google calendar");
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
