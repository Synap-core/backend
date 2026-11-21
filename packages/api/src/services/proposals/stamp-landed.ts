/**
 * THE landed stamp (`data.landed`, `@synap-core/types/proposals/landed`):
 * written once, by the approval tail every approve door shares
 * (`completeProposalApproval`), after the apply. It joins what the apply
 * recorded on the row (`data.materialized`, `data.runResult`) with what the
 * executor returned and nothing else stores (`primaryId`, a verified effect's
 * ids). A row without it is read from its records (`proposalLanded`).
 */

import { db, drizzleSql, eq, proposals } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  PROPOSAL_LANDED_KEY,
  landedFromRecord,
  landedKindOf,
  landedRoleOf,
  landedTargetOf,
  type ProposalLandedRef,
} from "@synap-core/types/proposals/landed";
import { isLikelyUUID } from "@synap-core/types/proposals";
import type { ProposalExecutorResult } from "../../routers/proposals/execution-registry.js";

const logger = createLogger({ module: "stamp-landed" });

const APPLIED = new Set(["approved", "auto_approved", "partially_approved"]);

/** What an approval landed, from the row as the apply left it and its result. Pure. */
export function landedOfApproval(input: {
  row: {
    status?: string | null;
    proposalType?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    data?: unknown;
  };
  result: Pick<ProposalExecutorResult, "primaryId" | "primaryKind" | "effect">;
}): ProposalLandedRef[] {
  const out = [...landedFromRecord(input.row.data)];
  const seen = new Set(out.map((r) => `${r.kind}:${r.id}`));
  const role = landedRoleOf(input.row);
  const add = (kindWord: string | null | undefined, id: unknown) => {
    const kind = landedKindOf(kindWord);
    if (!role || !kind || typeof id !== "string" || !isLikelyUUID(id)) return;
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, id, role });
  };
  const { primaryId, primaryKind, effect } = input.result;
  if (primaryId && primaryKind !== null) {
    add(primaryKind ?? input.row.targetType, primaryId);
  }
  // The statement's own table names the kind of the ids it returned.
  if (effect?.applied === "verified") {
    for (const id of effect.ids ?? []) add(effect.subject, id);
  }
  if (out.length === 0) {
    const target = landedTargetOf(input.row);
    if (target) out.push(target);
  }
  return out;
}

/**
 * Stamp what the approval of `proposalId` landed. Once: a row already stamped
 * (a re-approve joining an applied one) is left as it is. Only an applied row
 * is stamped. A failure is logged, never thrown: the approval has applied.
 */
export async function stampLanded(
  proposalId: string,
  result: Pick<ProposalExecutorResult, "primaryId" | "primaryKind" | "effect">,
  database: typeof db = db
): Promise<ProposalLandedRef[] | null> {
  try {
    const row = await database.query.proposals.findFirst({
      where: eq(proposals.id, proposalId),
      columns: {
        status: true,
        proposalType: true,
        targetType: true,
        targetId: true,
        data: true,
      },
    });
    if (!row || !APPLIED.has(row.status)) return null;
    const data = row.data as Record<string, unknown> | null;
    if (Array.isArray(data?.[PROPOSAL_LANDED_KEY])) return null;
    const landed = landedOfApproval({ row, result });
    await database
      .update(proposals)
      .set({
        data: drizzleSql`COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object(${PROPOSAL_LANDED_KEY}::text, ${JSON.stringify(landed)}::jsonb)`,
      })
      .where(eq(proposals.id, proposalId));
    return landed;
  } catch (err) {
    logger.warn({ err, proposalId }, "landed stamp failed after an approval");
    return null;
  }
}
