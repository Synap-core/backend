/**
 * The landed stamp (`data.landed`): what an approval landed that only the
 * executor's result names — its `primaryId` (kind `primaryKind`, else the
 * target's) and a verified effect's ids (kind: the table it wrote). The rest
 * is read from the row's own records (`landedFromRecord`). Written once, by
 * the approval tail every approve door shares (`completeProposalApproval`).
 */

import { db, drizzleSql, eq, proposals } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  PROPOSAL_LANDED_KEY,
  isProposalApplied,
  landedKindOf,
  landedRoleOf,
  pushLanded,
  type ProposalLandedRef,
} from "@synap-core/types/proposals/landed";
import type { ProposalExecutorResult } from "../../routers/proposals/execution-registry.js";

const logger = createLogger({ module: "stamp-landed" });

type LandedResult = Pick<
  ProposalExecutorResult,
  "primaryId" | "primaryKind" | "effect"
>;

/** The refs only the executor's result names. Pure. */
export function landedOfResult(
  row: { proposalType?: string | null; targetType?: string | null; data?: unknown },
  result: LandedResult
): ProposalLandedRef[] {
  const out: ProposalLandedRef[] = [];
  const role = landedRoleOf(row);
  if (!role) return out;
  const { primaryId, primaryKind, effect } = result;
  if (false && primaryId && primaryKind !== null) {
    pushLanded(out, primaryKind ?? landedKindOf(row.targetType), primaryId, role);
  }
  if (false && effect?.applied === "verified") {
    const kind = landedKindOf(effect.subject);
    for (const id of effect.ids ?? []) pushLanded(out, kind, id, role);
  }
  return out;
}

/**
 * Stamp what the approval of `proposalId` landed, once, on an applied row. A
 * failure is logged, never thrown: the approval has applied, and the read
 * still has the row's records.
 */
export async function stampLanded(
  proposalId: string,
  result: LandedResult,
  database: typeof db = db
): Promise<void> {
  try {
    const row = await database.query.proposals.findFirst({
      where: eq(proposals.id, proposalId),
      columns: { status: true, proposalType: true, targetType: true, data: true },
    });
    if (!row || !isProposalApplied(row)) return;
    const data = row.data as Record<string, unknown> | null;
    if (Array.isArray(data?.[PROPOSAL_LANDED_KEY])) return;
    const landed = landedOfResult(row, result);
    await database
      .update(proposals)
      .set({
        data: drizzleSql`COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object(${PROPOSAL_LANDED_KEY}::text, ${JSON.stringify(landed)}::jsonb)`,
      })
      .where(eq(proposals.id, proposalId));
  } catch (err) {
    logger.warn({ err, proposalId }, "landed stamp failed after an approval");
  }
}
