/**
 * Pure view-model helpers for `governance_rules` rows, as pod admin lists
 * them. The words are NOT here: they are `@synap-core/types/governance-rules`,
 * the one home the browser and the phone read too (this file used to be a
 * hand-kept copy of the browser's, and it drifted: a computers rule read
 * "Any agent"). What stays is pod admin's own: its row type, derived from the
 * router output, and the connection lookup built from its connectors read.
 */

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import { humanizeToken } from "@synap-core/types/vocabulary";

export {
  humanizePrincipal,
  humanizeScope,
  humanizeTarget,
  provenanceLabel,
  ruleProvenance,
  verdictLabel,
  type HumanizeTargetOptions,
  type RuleProvenance,
} from "@synap-core/types/governance-rules";

/** One `governanceRules.list` row, as the router returns it (never a hand mirror). */
export type GovernanceRuleRow =
  inferRouterOutputs<AppRouter>["governanceRules"]["list"]["rules"][number];

/** One row of `trpc.connectors.allConnections` — only the fields this file reads. */
export interface AllConnectionsRow {
  registryConnectionId: string;
  providerId: string | null;
}

/**
 * Build the `connectionLabel` lookup `humanizeTarget` needs, from
 * `connectors.allConnections`. Keyed by `registryConnectionId` — the id a
 * "connection" rule's `targetPattern` actually holds (the registry row id,
 * not the broker's own `connectionId`/accountHint on the same row).
 */
export function buildConnectionLabelLookup(
  rows: readonly AllConnectionsRow[]
): (connectionId: string) => string | undefined {
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.providerId)
      map.set(r.registryConnectionId, humanizeToken(r.providerId));
  }
  return (connectionId: string) => map.get(connectionId);
}
