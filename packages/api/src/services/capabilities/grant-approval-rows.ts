/**
 * The approval rows that travel with a capability grant (decision D2, 19 Nov
 * 2026, document b387ca45): a grant means only "may use" (scope, expiry,
 * uses); whether the tool runs without asking is an approval row
 * (`governance_rules`, target `capability`), the ONE store the capability
 * gate reads.
 *
 * Two doors write or take back such a row next to a grant:
 *   - a session pre-approval (`focusSessions.grantCapability`) writes, per
 *     granted part, "this agent (or anyone, when none is named) × this action
 *     × this space → auto", the verdict its grant's `exec_mode = 'auto'`
 *     carried before 0435;
 *   - revoking a grant (`capabilityGrants.revoke`, a retired part) takes back
 *     the auto rows on exactly that grant's agent × action × space, so a
 *     revoked pre-approval asks again, as it did when the grant held the mode.
 */

import {
  and,
  eq,
  inArray,
  isNull,
  type db,
  SESSION_GRANT_CREATED_BY_PREFIX,
} from "@synap/database";
import { governanceRules } from "@synap/database/schema";

/** The pod handle or a transaction on it. */
type Tx = Pick<typeof db, "select" | "insert" | "update">;

/** The agent × space a grant binds (null = anyone / the pod). */
export interface GrantBinding {
  grantedTo: string | null;
  workspaceId: string | null;
}

/** The rows on exactly this binding × these actions (active or not). */
function bindingWhere(binding: GrantBinding, grantableIds: string[]) {
  return and(
    eq(governanceRules.targetKind, "capability"),
    inArray(governanceRules.targetPattern, grantableIds),
    binding.grantedTo
      ? and(
          eq(governanceRules.principalKind, "agent"),
          eq(governanceRules.agentUserId, binding.grantedTo)
        )
      : eq(governanceRules.principalKind, "any"),
    binding.workspaceId
      ? and(
          eq(governanceRules.scopeKind, "workspace"),
          eq(governanceRules.workspaceId, binding.workspaceId)
        )
      : eq(governanceRules.scopeKind, "pod"),
    isNull(governanceRules.targetSubjectId),
    isNull(governanceRules.revokedAt)
  );
}

/**
 * Write "auto" for each granted part on the grant's binding, once: a part
 * that already has an active auto row on that binding gets no second one.
 */
export async function writeSessionGrantApprovalRows(
  tx: Tx,
  input: GrantBinding & { sessionId: string; partIds: string[] }
): Promise<void> {
  if (input.partIds.length === 0) return;
  const existing = (await tx
    .select({ targetPattern: governanceRules.targetPattern })
    .from(governanceRules)
    .where(
      and(
        bindingWhere(input, input.partIds),
        eq(governanceRules.verdict, "auto")
      )
    )) as Array<{ targetPattern: string }>;
  const have = new Set(existing.map((r) => r.targetPattern));
  const missing = [...new Set(input.partIds)].filter((id) => !have.has(id));
  if (missing.length === 0) return;
  await tx.insert(governanceRules).values(
    missing.map((id) => ({
      principalKind: input.grantedTo ? ("agent" as const) : ("any" as const),
      agentUserId: input.grantedTo,
      principalClass: null,
      scopeKind: input.workspaceId ? ("workspace" as const) : ("pod" as const),
      workspaceId: input.workspaceId,
      targetKind: "capability" as const,
      targetPattern: id,
      targetProfile: null,
      verdict: "auto" as const,
      createdBy: `${SESSION_GRANT_CREATED_BY_PREFIX}${input.sessionId}`,
      expiresAt: null,
    }))
  );
}

/**
 * Take back the "auto" rows a revoked grant stood for: the active auto rows
 * on exactly its agent × action × space. An "ask first" or a "Never" on the
 * same binding is left alone (it only ever tightens).
 */
export async function revokeGrantApprovalRows(
  tx: Tx,
  grants: ReadonlyArray<GrantBinding & { grantableId: string }>
): Promise<void> {
  const now = new Date();
  for (const g of grants) {
    await tx
      .update(governanceRules)
      .set({ revokedAt: now })
      .where(
        and(
          bindingWhere(g, [g.grantableId]),
          eq(governanceRules.verdict, "auto")
        )
      );
  }
}
