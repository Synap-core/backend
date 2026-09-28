/**
 * NEXT RUNG — the server half of the trust ladder (`@synap-core/types/trust-ladder`).
 *
 * The leaf decides the ladder from wire fields, but one input it must not
 * compute itself: whether the write is REVERSIBLE. That is the engine's door
 * class (`isReversibleWrite`, `@synap/governance-policy`), and only the server
 * may read it — so every card's offer is PROJECTED here, never re-derived by a
 * client from a copied list.
 *
 * `readNextRungs` is the read (a card asks "what is my next rung?");
 * `fileNextRung` is the write the `governanceRules.proposeNextRung` door runs
 * once the router has decided WHO may grant it (direct rule vs a proposal for
 * the agent's owner). No new store: the rule lands in `governance_rules`
 * through the ONE store-write `applyGovConfigChange`, or as a pending
 * `settings.update` whose approval runs that same write.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  isNull,
  or,
  gt,
  proposals,
  governanceRules,
  insertPendingProposal,
  authoredCreatedBy,
} from "@synap/database";
import { users } from "@synap/database/schema";
import {
  REVERSIBLE_CLASS_PATTERN,
  isReversibleWrite,
  nonWidenableFloorFor,
} from "@synap/governance-policy";
import {
  nextRung,
  nextRungRuleDraft,
  proposalEventKey,
  resolveTrustRung,
  type NextRungOffer,
  type TrustRung,
} from "@synap-core/types/trust-ladder";

/** The exact `governanceRules.create`-shaped rule a grant writes. */
type GovernanceRuleDraft = ReturnType<typeof nextRungRuleDraft>;
import { assertProposalVisibleTo } from "../../utils/proposal-visibility.js";
import { applyGovConfigChange } from "./gov-config.js";
import { notifyProposalCreatedOrdered } from "../../notifications/notify-proposal-created-ordered.js";

/** A batch read is per card on one screen, never a scan. */
export const NEXT_RUNG_BATCH_MAX = 50;

/** The proposal columns the ladder reads. */
export interface NextRungRow {
  id: string;
  status: string;
  proposalType: string;
  targetType: string;
  workspaceId: string | null;
  agentUserId: string | null;
  governanceReason: string | null;
  data: unknown;
  /**
   * Receipts only: a specific rule (not the `@reversible` pod default)
   * executed it — see {@link resolveGrantedByRule}. Absent ⇒ not resolved.
   */
  grantedByRule?: boolean;
}

/** The `governance_rules` id a receipt's `_autoApprove` marker names. */
function receiptRuleId(row: Pick<NextRungRow, "status" | "data">): string | null {
  if (row.status !== "auto_approved") return null;
  const marker = (row.data as { _autoApprove?: { governanceRuleId?: unknown } } | null)
    ?._autoApprove;
  return typeof marker?.governanceRuleId === "string"
    ? marker.governanceRuleId
    : null;
}

/**
 * Stamp `grantedByRule` on receipts: TRUE when the rule that executed it is a
 * person's standing rule ("just do it"), FALSE when it was the pod default's
 * `@reversible` class row or no rule at all ("do + tell"). A rule since
 * revoked still counts — the receipt records what decided it THEN.
 */
export async function resolveGrantedByRule(
  rows: NextRungRow[]
): Promise<NextRungRow[]> {
  const ruleIds = [
    ...new Set(rows.map(receiptRuleId).filter((id): id is string => !!id)),
  ];
  const specific = new Set<string>();
  if (ruleIds.length > 0) {
    const rules = await db
      .select({
        id: governanceRules.id,
        targetPattern: governanceRules.targetPattern,
      })
      .from(governanceRules)
      .where(inArray(governanceRules.id, ruleIds));
    for (const r of rules) {
      if (r.targetPattern !== REVERSIBLE_CLASS_PATTERN) specific.add(r.id);
    }
  }
  return rows.map((row) => {
    if (row.status !== "auto_approved") return row;
    const ruleId = receiptRuleId(row);
    return { ...row, grantedByRule: ruleId ? specific.has(ruleId) : false };
  });
}

/**
 * The profile slug the GATE saw for this write — the value rung 2.8 matched a
 * `targetProfile` against. A receipt spreads the gate `data` FLAT; a pending
 * row nests it under the request envelope's `data` (`createProposal`,
 * `permission-check.ts`). Reading the wrong one mints a rule narrowed to a
 * slug the next write never carries, which never fires.
 */
export function gateProfileSlug(row: Pick<NextRungRow, "status" | "data">): string | null {
  const data = (row.data ?? null) as Record<string, unknown> | null;
  if (!data) return null;
  if (row.status === "auto_approved") {
    return typeof data.profileSlug === "string" && data.profileSlug
      ? data.profileSlug
      : null;
  }
  const inner = data.data as Record<string, unknown> | null | undefined;
  return inner && typeof inner.profileSlug === "string" && inner.profileSlug
    ? inner.profileSlug
    : null;
}

export interface NextRungProjection {
  proposalId: string;
  rung: TrustRung | null;
  offer: NextRungOffer | null;
  /** The exact rule accepting the offer writes; `null` when there is no offer. */
  rule: GovernanceRuleDraft | null;
}

/**
 * The ladder for one proposal row. Pure apart from the engine constants.
 *
 * Belt and braces on the floors: the leaf already refuses a floored reason
 * code and an irreversible write; `nonWidenableFloorFor` is asked as well, so a
 * key the engine floors can never get an offer even if a reason code was never
 * stored on the row.
 */
export function projectNextRung(row: NextRungRow): NextRungProjection {
  const item = {
    kind: "proposal" as const,
    status: row.status,
    proposalType: row.proposalType,
    targetType: row.targetType,
    grantedByRule: row.grantedByRule ?? null,
  };
  const rung = resolveTrustRung(item);
  const eventKey = proposalEventKey(row);
  const offer =
    nonWidenableFloorFor(eventKey) === null
      ? nextRung({
          item,
          agentUserId: row.agentUserId,
          governanceReason: row.governanceReason,
          reversible: isReversibleWrite(eventKey),
        })
      : null;
  return {
    proposalId: row.id,
    rung,
    offer,
    rule:
      offer && row.agentUserId
        ? nextRungRuleDraft({
            proposalId: row.id,
            agentUserId: row.agentUserId,
            workspaceId: row.workspaceId,
            eventKey,
            profileSlug: gateProfileSlug(row),
          })
        : null,
  };
}

const ROW_COLUMNS = {
  id: proposals.id,
  status: proposals.status,
  proposalType: proposals.proposalType,
  targetType: proposals.targetType,
  workspaceId: proposals.workspaceId,
  agentUserId: proposals.agentUserId,
  governanceReason: proposals.governanceReason,
  data: proposals.data,
};

/**
 * The ladder for each card the caller can SEE. A proposal the caller may not
 * see is OMITTED — the same answer as one that does not exist (telling them
 * the id is real is the leak, smaller). Visibility is `assertProposalVisibleTo`,
 * the SSOT every proposal-binding path uses.
 */
export async function readNextRungs(params: {
  userId: string;
  proposalIds: readonly string[];
}): Promise<NextRungProjection[]> {
  const ids = [...new Set(params.proposalIds)].slice(0, NEXT_RUNG_BATCH_MAX);
  if (ids.length === 0) return [];
  const rows = (await db
    .select(ROW_COLUMNS)
    .from(proposals)
    .where(inArray(proposals.id, ids))) as NextRungRow[];
  const out: NextRungProjection[] = [];
  for (const row of await resolveGrantedByRule(rows)) {
    try {
      await assertProposalVisibleTo(row.id, params.userId);
    } catch {
      continue;
    }
    out.push(projectNextRung(row));
  }
  return out;
}

/** Load ONE row behind the visibility floor, or throw NOT_FOUND/FORBIDDEN. */
export async function loadVisibleNextRungRow(
  userId: string,
  proposalId: string
): Promise<NextRungRow> {
  await assertProposalVisibleTo(proposalId, userId);
  const [row] = (await db
    .select(ROW_COLUMNS)
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1)) as NextRungRow[];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
  }
  const [resolved] = await resolveGrantedByRule([row]);
  return resolved!;
}

/** An ACTIVE rule that already says exactly what the draft would. */
async function findCoveringRule(
  rule: GovernanceRuleDraft
): Promise<string | null> {
  const [hit] = await db
    .select({ id: governanceRules.id })
    .from(governanceRules)
    .where(
      and(
        isNull(governanceRules.revokedAt),
        or(
          isNull(governanceRules.expiresAt),
          gt(governanceRules.expiresAt, new Date())
        ),
        eq(governanceRules.principalKind, "agent"),
        eq(governanceRules.agentUserId, rule.agentUserId!),
        eq(governanceRules.scopeKind, rule.scopeKind),
        rule.workspaceId
          ? eq(governanceRules.workspaceId, rule.workspaceId)
          : isNull(governanceRules.workspaceId),
        eq(governanceRules.targetKind, "action"),
        eq(governanceRules.targetPattern, rule.targetPattern),
        rule.targetProfile
          ? eq(governanceRules.targetProfile, rule.targetProfile)
          : isNull(governanceRules.targetProfile),
        eq(governanceRules.verdict, "auto")
      )
    )
    .limit(1);
  return hit?.id ?? null;
}

export type FileNextRungResult =
  | { outcome: "created"; ruleId: string; offer: NextRungOffer }
  | { outcome: "already_covered"; ruleId: string; offer: NextRungOffer }
  | { outcome: "proposed"; proposalId: string; offer: NextRungOffer };

/**
 * Accept the next-rung offer on one card.
 *
 * `mayGrant` is the ROUTER's verdict on `assertCanManageRule` (the gate
 * `governanceRules.create` applies): the caller owns the agent (or is a pod
 * admin) and may manage a rule of this scope. Then the click IS the approval
 * and the rule is written now. Otherwise a pending `settings.update` is filed
 * for the agent's owner — the unified gov-config door, pod-admin to approve,
 * applied by the same `applyGovConfigChange`.
 *
 * Refuses (PRECONDITION_FAILED) when the card has no offer — the floors, an
 * irreversible write, a "no", no agent: nothing is ever granted past them.
 */
export async function fileNextRung(params: {
  userId: string;
  row: NextRungRow;
  mayGrant: boolean;
}): Promise<FileNextRungResult> {
  const projection = projectNextRung(params.row);
  if (!projection.offer || !projection.rule) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "NO_NEXT_RUNG: this item has no next rung to grant (a floor routed it, the write cannot be undone, it was declined, or no agent made it).",
    });
  }
  const { offer, rule } = projection;

  const covering = await findCoveringRule(rule);
  if (covering) {
    return { outcome: "already_covered", ruleId: covering, offer };
  }

  const spec = {
    principalKind: rule.principalKind,
    agentUserId: rule.agentUserId ?? null,
    scopeKind: rule.scopeKind,
    workspaceId: rule.workspaceId ?? null,
    targetKind: rule.targetKind,
    targetPattern: rule.targetPattern,
    targetProfile: rule.targetProfile ?? null,
    verdict: rule.verdict,
  };

  if (params.mayGrant) {
    const written = await applyGovConfigChange({
      store: "governance_rules",
      op: "set",
      spec,
      // LINEAGE: the card the person granted it from.
      sourceProposalId: params.row.id,
      // A person authored this grant, by clicking it — the `user:` namespace
      // `governanceRules.create` stamps, never a machine namespace.
      createdBy: authoredCreatedBy(params.userId),
    });
    const ruleId = written.ids[0];
    if (!ruleId) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The rule write returned no row.",
      });
    }
    return { outcome: "created", ruleId, offer };
  }

  // Not the caller's to grant: the agent's OWNER decides (owner floor, 0248).
  const [agent] = await db
    .select({ createdByUserId: users.createdByUserId })
    .from(users)
    .where(eq(users.id, rule.agentUserId!))
    .limit(1);
  const owner = agent?.createdByUserId;
  if (!owner) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "NO_NEXT_RUNG: the agent has no owner to decide this.",
    });
  }
  const { proposal, deduped } = await insertPendingProposal({
    workspaceId: null,
    targetType: "settings",
    targetId: rule.agentUserId!,
    proposalType: "settings.update",
    data: {
      store: "governance_rules",
      op: "set",
      ...spec,
      nextRungFromProposalId: params.row.id,
    } as Record<string, unknown>,
    createdBy: params.userId,
    proposedByUserId: params.userId,
    subjectUserId: owner,
  });
  await notifyProposalCreatedOrdered({
    podWide: deduped
      ? null
      : {
          proposalId: proposal.id,
          proposalType: "settings.update",
          description: `Next time, let this agent do "${rule.targetPattern}" and tell you?`,
          agentUserId: rule.agentUserId!,
        },
    sideEffect: {
      subjectId: proposal.id,
      userId: owner,
      data: {
        proposalStatus: "created",
        targetType: "settings",
        changeType: "settings.update",
      },
    },
  });
  return { outcome: "proposed", proposalId: proposal.id, offer };
}
