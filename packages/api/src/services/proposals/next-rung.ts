/**
 * NEXT RUNG — the server half of the trust ladder (`@synap-core/types/trust-ladder`).
 *
 * The leaf decides the ladder from wire fields, but one input it must not
 * compute itself: whether the write is REVERSIBLE. That is the engine's door
 * class (`isReversibleWrite`, `@synap/governance-policy`), and only the server
 * may read it — so every card's offer is PROJECTED here, never re-derived by a
 * client from a copied list.
 *
 * `readNextRungs` is the read (a card asks "what is my next rung?", and how far
 * the agent has EARNED it: `streak`, the one rule `earnedStreak`);
 * `readAlwaysApproved` is the Calibration read of the same projection (kinds
 * with a met streak and no rule yet); `fileNextRung` is the write the
 * `governanceRules.proposeNextRung` door runs
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
  desc,
  drizzleSql,
  inArray,
  isNotNull,
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
  OWN_ORGANISE_CLASS_PATTERN,
  REVERSIBLE_CLASS_PATTERN,
  isReversibleWrite,
  nonWidenableFloorFor,
} from "@synap/governance-policy";
import {
  earnedStreak,
  nextRung,
  nextRungRuleDraft,
  proposalEventKey,
  resolveTrustRung,
  NO_NEXT_RUNG_CODE,
  RULE_PAUSED_AFTER_REVERTS,
  type EarnedStreak,
  type NextRungCovered,
  type NextRungOffer,
  type NextRungPaused,
  type StreakDecision,
  type TrustRung,
} from "@synap-core/types/trust-ladder";
import { createLogger } from "@synap-core/core";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";

/** The exact `governanceRules.create`-shaped rule a grant writes. */
type GovernanceRuleDraft = ReturnType<typeof nextRungRuleDraft>;
/** A draft's identity and spec — its lineage travels separately. */
export type RuleGrantDraft = Omit<GovernanceRuleDraft, "sourceProposalId">;
import {
  assertProposalVisibleTo,
  visibleProposalIds,
} from "../../utils/proposal-visibility.js";
import { applyGovConfigChange } from "./gov-config.js";
import { notifyProposalCreatedOrdered } from "../../notifications/notify-proposal-created-ordered.js";

/** A batch read is per card on one screen, never a scan. */
export const NEXT_RUNG_BATCH_MAX = 50;

/**
 * The newest decisions read per grant key. Every row the evidence read keeps
 * counts or breaks the run, so this bounds the longest run reported, never
 * whether ten are met.
 */
const STREAK_LOOKBACK = 50;

/** Calibration's "Always approved": the newest approvals scanned for kinds. */
const ALWAYS_APPROVED_SCAN = 500;

const logger = createLogger({ module: "next-rung" });

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
function receiptRuleId(
  row: Pick<NextRungRow, "status" | "data">
): string | null {
  if (row.status !== "auto_approved") return null;
  const marker = (
    row.data as { _autoApprove?: { governanceRuleId?: unknown } } | null
  )?._autoApprove;
  return typeof marker?.governanceRuleId === "string"
    ? marker.governanceRuleId
    : null;
}

/**
 * The pod DEFAULTS' class rows — seeded by the pod, switchable in Settings ›
 * Approvals, never a rule a person wrote. A receipt one of them decided is
 * "do + tell", not "a rule you set" (FB1020 w2 plan FBD-3: `@own-organise`
 * receipts read as the person's own rule).
 */
const POD_DEFAULT_CLASS_PATTERNS: ReadonlySet<string> = new Set([
  REVERSIBLE_CLASS_PATTERN,
  OWN_ORGANISE_CLASS_PATTERN,
]);

/**
 * Stamp `grantedByRule` on receipts: TRUE when the rule that executed it is a
 * person's standing rule ("just do it"), FALSE when it was a pod default's
 * class row (`@reversible`, `@own-organise`) or no rule at all ("do + tell").
 * A rule since revoked still counts — the receipt records what decided it THEN.
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
      if (!POD_DEFAULT_CLASS_PATTERNS.has(r.targetPattern)) specific.add(r.id);
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
export function gateProfileSlug(
  row: Pick<NextRungRow, "status" | "data">
): string | null {
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
  /**
   * An ACTIVE rule already says exactly what the offer would: the offer is
   * withdrawn (`offer: null`) and this names the rule, so a surface shows
   * "Already a rule" as a DOOR to it. `null` when nothing covers the card.
   */
  covered: NextRungCovered | null;
  /**
   * How far the agent has EARNED this offer (`earnedStreak`), set only where
   * there is an offer. `null` WITH an offer = the history could not be read —
   * never an empty streak (decision e8939070). A streak never creates an offer
   * the ladder refuses.
   */
  streak: EarnedStreak | null;
  /**
   * The grant on this kind PAUSED itself after undos: the card offers "Ask me
   * again" and names the rule (a door). Only approvals after the pause count.
   */
  paused: NextRungPaused | null;
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
  // The kind the GATE saw (never one looked up afterwards): an entity grant
  // without it would cover every kind, so the leaf refuses it
  // (`PROFILED_SUBJECTS`). NB an entity UPDATE carries a profile only when it
  // changes the type — which is force-proposed (a floor) — so updates get no
  // offer until the gate is given the entity's own type (open, see the W7
  // review report).
  const profileSlug = gateProfileSlug(row);
  // The scope is the proposal's own workspace: the gate governed the write in
  // exactly that workspace (for an entity, its HOME space — `mutate.ts`
  // `governanceWorkspaceId = existing.workspaceId`), so it is the narrowest
  // scope that still FIRES. `null` ⇒ the gate saw no space ⇒ pod reach, which
  // the offer states (`reach: "pod"`) instead of applying silently.
  const offer =
    nonWidenableFloorFor(eventKey) === null
      ? nextRung({
          item,
          agentUserId: row.agentUserId,
          governanceReason: row.governanceReason,
          reversible: isReversibleWrite(eventKey),
          profileSlug,
          workspaceId: row.workspaceId,
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
            profileSlug,
          })
        : null,
    covered: null,
    streak: null,
    paused: null,
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
 * The ladder for each card the caller can SEE, in a FIXED number of queries
 * whatever the batch size. A proposal the caller may not see is OMITTED — the
 * same answer as one that does not exist. Visibility is `visibleProposalIds`,
 * the batch form of `assertProposalVisibleTo` (kept in step by a parity test).
 * A card an active rule already covers has its offer WITHDRAWN and names the
 * rule (`covered: { ruleId }`).
 */
export async function readNextRungs(params: {
  userId: string;
  proposalIds: readonly string[];
}): Promise<NextRungProjection[]> {
  const ids = [...new Set(params.proposalIds)].slice(0, NEXT_RUNG_BATCH_MAX);
  if (ids.length === 0) return [];
  const visible = await visibleProposalIds(ids, params.userId);
  if (visible.size === 0) return [];
  const rows = (await db
    .select(ROW_COLUMNS)
    .from(proposals)
    .where(inArray(proposals.id, [...visible]))) as NextRungRow[];
  const projections = (await resolveGrantedByRule(rows)).map(projectNextRung);
  const covering = await findCoveringRules(
    projections.flatMap((p) => (p.rule ? [p.rule] : []))
  );
  const open = projections.map((p) => {
    const ruleId = p.rule ? covering.get(ruleKey(p.rule)) : undefined;
    return ruleId ? { ...p, offer: null, rule: null, covered: { ruleId } } : p;
  });
  return withEarnedEvidence(open);
}

/** A projection with its streak and pause read, when it carries an offer. */
async function withEarnedEvidence(
  projections: NextRungProjection[]
): Promise<NextRungProjection[]> {
  const drafts = projections.flatMap((p) =>
    p.offer && p.rule ? [p.rule] : []
  );
  if (drafts.length === 0) return projections;
  const evidence = await readEarnedEvidence(drafts);
  return projections.map((p) => {
    if (!p.offer || !p.rule) return p;
    const e = evidence?.get(ruleKey(p.rule));
    return { ...p, streak: e?.streak ?? null, paused: e?.paused ?? null };
  });
}

/** A stored `auto` action rule as the draft it would be — its {@link ruleKey}. */
function draftOfRow(r: {
  agentUserId: string | null;
  workspaceId: string | null;
  targetPattern: string;
  targetProfile: string | null;
}): RuleGrantDraft {
  return {
    principalKind: "agent",
    agentUserId: r.agentUserId ?? undefined,
    scopeKind: r.workspaceId ? "workspace" : "pod",
    ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
    targetKind: "action",
    targetPattern: r.targetPattern,
    ...(r.targetProfile ? { targetProfile: r.targetProfile } : {}),
    verdict: "auto",
  };
}

type EarnedEvidence = { streak: EarnedStreak; paused: NextRungPaused | null };

/**
 * The streak and the pause for each drafted grant, in TWO queries whatever the
 * batch: the newest {@link STREAK_LOOKBACK} decisions per grant key (agent ×
 * space × exact action × the kind the gate saw — {@link ruleKey}, so what is
 * counted is exactly what accepting would grant), and the paused rules of
 * those agents.
 *
 * Only rows that COUNT or BREAK in `earnedStreak` are read (approved,
 * rejected, reverted, or undone and re-proposed): receipts, withdrawn and
 * expired rows are never evidence.
 *
 * `null` when the history could not be read: the caller shows NO streak,
 * never an empty one (decision e8939070).
 */
async function readEarnedEvidence(
  drafts: readonly RuleGrantDraft[]
): Promise<Map<string, EarnedEvidence> | null> {
  const agentIds = [
    ...new Set(
      drafts.map((d) => d.agentUserId).filter((a): a is string => !!a)
    ),
  ];
  if (agentIds.length === 0) return new Map();
  try {
    // `proposalEventKey`: a receipt's dotted type, a pending row's bare verb.
    const eventKey = drizzleSql<string>`case when left(${proposals.proposalType}, length(${proposals.targetType}) + 1) = ${proposals.targetType} || '.' then ${proposals.proposalType} else ${proposals.targetType} || '.' || ${proposals.proposalType} end`;
    // The kind the GATE saw (`gateProfileSlug`): a receipt — a reverted one
    // too — spreads it flat; a reviewed row nests it in the request envelope.
    const profileSlug = drizzleSql<
      string | null
    >`nullif(case when ${proposals.data} ? '_autoApprove' then ${proposals.data}->>'profileSlug' else ${proposals.data}->'data'->>'profileSlug' end, '')`;
    const decidedAt = drizzleSql`coalesce(${proposals.reviewedAt}, ${proposals.updatedAt}, ${proposals.createdAt})`;
    const ranked = db
      .select({
        agentUserId: proposals.agentUserId,
        workspaceId: proposals.workspaceId,
        eventKey: eventKey.as("event_key"),
        profileSlug: profileSlug.as("profile_slug"),
        status: proposals.status,
        data: proposals.data,
        revisionHistory: proposals.revisionHistory,
        createdAt: proposals.createdAt,
        reviewedAt: proposals.reviewedAt,
        reviewedBy: proposals.reviewedBy,
        rank: drizzleSql<number>`row_number() over (partition by ${proposals.agentUserId}, ${proposals.workspaceId}, ${eventKey}, ${profileSlug} order by ${decidedAt} desc)`.as(
          "streak_rank"
        ),
      })
      .from(proposals)
      .where(
        and(
          inArray(proposals.agentUserId, agentIds),
          or(
            inArray(proposals.status, ["approved", "rejected", "reverted"]),
            drizzleSql`${proposals.data} ? 'revertedAt'`
          )
        )
      )
      .as("streak_evidence");
    const rows = await db
      .select()
      .from(ranked)
      .where(drizzleSql`${ranked.rank} <= ${STREAK_LOOKBACK}`);

    const pausedRows = await db
      .select({
        id: governanceRules.id,
        agentUserId: governanceRules.agentUserId,
        workspaceId: governanceRules.workspaceId,
        targetPattern: governanceRules.targetPattern,
        targetProfile: governanceRules.targetProfile,
        revokedAt: governanceRules.revokedAt,
      })
      .from(governanceRules)
      .where(
        and(
          eq(governanceRules.revokedReason, RULE_PAUSED_AFTER_REVERTS),
          isNotNull(governanceRules.revokedAt),
          eq(governanceRules.principalKind, "agent"),
          inArray(governanceRules.agentUserId, agentIds),
          eq(governanceRules.targetKind, "action"),
          eq(governanceRules.verdict, "auto")
        )
      );
    // The LATEST pause per key is the one the card names.
    const pausedByKey = new Map<string, NextRungPaused>();
    for (const r of pausedRows) {
      const key = ruleKey(draftOfRow(r));
      const prior = pausedByKey.get(key);
      if (!prior || r.revokedAt!.getTime() > Date.parse(prior.revokedAt)) {
        pausedByKey.set(key, {
          ruleId: r.id,
          revokedAt: r.revokedAt!.toISOString(),
        });
      }
    }

    const decisionsByKey = new Map<string, StreakDecision[]>();
    for (const r of rows) {
      const key = ruleKey(
        draftOfRow({
          agentUserId: r.agentUserId,
          workspaceId: r.workspaceId,
          targetPattern: r.eventKey,
          targetProfile: r.profileSlug,
        })
      );
      const list = decisionsByKey.get(key) ?? [];
      list.push(r);
      decisionsByKey.set(key, list);
    }

    const out = new Map<string, EarnedEvidence>();
    for (const d of drafts) {
      const key = ruleKey(d);
      const paused = pausedByKey.get(key) ?? null;
      // After a pause the agent earns it again from scratch: the approvals
      // that earned the paused grant are spent.
      const after = paused ? Date.parse(paused.revokedAt) : null;
      const decisions = (decisionsByKey.get(key) ?? []).filter(
        (r) =>
          after === null ||
          new Date(r.reviewedAt ?? r.createdAt).getTime() > after
      );
      out.set(key, {
        streak: earnedStreak(decisions, d.agentUserId),
        paused,
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "next-rung: streak history unreadable — no streak");
    return null;
  }
}

/**
 * Settings › Trust rules › Calibration, "Always approved": the kinds of work
 * the caller can see whose earned streak is MET and that no active rule covers
 * yet — each as the projection of its newest approval (the exemplar), so
 * accepting one is `proposeNextRung` on that card: the same guards, the same
 * back half (`fileRuleGrant`). Bounded: the newest
 * {@link ALWAYS_APPROVED_SCAN} approvals, at most {@link NEXT_RUNG_BATCH_MAX}
 * kinds. `readable: false` when the history could not be read.
 */
export async function readAlwaysApproved(params: {
  userId: string;
}): Promise<{ readable: boolean; kinds: NextRungProjection[] }> {
  const recent = (await db
    .select(ROW_COLUMNS)
    .from(proposals)
    .where(
      and(
        eq(proposals.status, "approved"),
        isNotNull(proposals.agentUserId),
        isNotNull(proposals.reviewedBy)
      )
    )
    .orderBy(desc(proposals.reviewedAt))
    .limit(ALWAYS_APPROVED_SCAN)) as NextRungRow[];
  const visible = await visibleProposalIds(
    recent.map((r) => r.id),
    params.userId
  );
  const exemplars = new Map<string, NextRungProjection>();
  for (const row of recent) {
    if (!visible.has(row.id)) continue;
    const p = projectNextRung(row);
    if (!p.offer || !p.rule) continue;
    const key = ruleKey(p.rule);
    if (!exemplars.has(key)) exemplars.set(key, p);
    if (exemplars.size >= NEXT_RUNG_BATCH_MAX) break;
  }
  const covering = await findCoveringRules(
    [...exemplars.values()].map((p) => p.rule!)
  );
  const open = [...exemplars.entries()]
    .filter(([key]) => !covering.has(key))
    .map(([, p]) => p);
  if (open.length === 0) return { readable: true, kinds: [] };
  const evidence = await readEarnedEvidence(open.map((p) => p.rule!));
  if (!evidence) return { readable: false, kinds: [] };
  const kinds = open.flatMap((p) => {
    const e = evidence.get(ruleKey(p.rule!));
    return e?.streak.met ? [{ ...p, streak: e.streak, paused: e.paused }] : [];
  });
  return { readable: true, kinds };
}

/** The identity of a drafted rule — what "already covered" compares. */
function ruleKey(rule: RuleGrantDraft): string {
  return [
    rule.agentUserId ?? "",
    rule.scopeKind,
    rule.workspaceId ?? "",
    rule.targetPattern,
    rule.targetProfile ?? "",
  ].join("\u0000");
}

/**
 * ACTIVE agent-scoped `auto` action rules that say exactly what each draft
 * would — ONE query for the whole batch (the drafts' agents), matched in
 * memory by {@link ruleKey}. Returns draft key → covering rule id.
 */
async function findCoveringRules(
  drafts: readonly RuleGrantDraft[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const agentIds = [
    ...new Set(
      drafts.map((d) => d.agentUserId).filter((a): a is string => !!a)
    ),
  ];
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({
      id: governanceRules.id,
      agentUserId: governanceRules.agentUserId,
      scopeKind: governanceRules.scopeKind,
      workspaceId: governanceRules.workspaceId,
      targetPattern: governanceRules.targetPattern,
      targetProfile: governanceRules.targetProfile,
    })
    .from(governanceRules)
    .where(
      and(
        isNull(governanceRules.revokedAt),
        or(
          isNull(governanceRules.expiresAt),
          gt(governanceRules.expiresAt, new Date())
        ),
        eq(governanceRules.principalKind, "agent"),
        inArray(governanceRules.agentUserId, agentIds),
        eq(governanceRules.targetKind, "action"),
        eq(governanceRules.verdict, "auto")
      )
    );
  const byKey = new Map<string, string>();
  for (const r of rows) {
    byKey.set(
      ruleKey({
        principalKind: "agent",
        agentUserId: r.agentUserId ?? undefined,
        scopeKind: r.scopeKind,
        ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
        targetKind: "action",
        targetPattern: r.targetPattern,
        ...(r.targetProfile ? { targetProfile: r.targetProfile } : {}),
        verdict: "auto",
      }),
      r.id
    );
  }
  for (const d of drafts) {
    const hit = byKey.get(ruleKey(d));
    if (hit) out.set(ruleKey(d), hit);
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

export type FileNextRungResult =
  | { outcome: "created"; ruleId: string; offer: NextRungOffer }
  | { outcome: "already_covered"; ruleId: string; offer: NextRungOffer }
  | { outcome: "proposed"; proposalId: string; offer: NextRungOffer }
  | { outcome: "needs_admin"; proposalId: string; offer: NextRungOffer };

/**
 * The typed refusal: `error.data.reasonCode = NO_NEXT_RUNG` (the tRPC error
 * formatter lifts `cause.reasonCode`), read by `isNoNextRungError`; the
 * message keeps the pinned `NO_NEXT_RUNG:` prefix for older clients.
 */
export function noNextRung(detail: string): TRPCError {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `${NO_NEXT_RUNG_CODE}: ${detail}`,
    cause: Object.assign(new Error(NO_NEXT_RUNG_CODE), {
      reasonCode: NO_NEXT_RUNG_CODE,
    }),
  });
}

/**
 * The owner's review line, in the vocabulary's words — "Next time, let it
 * update notes and tell you?" — never a raw event key.
 */
export function nextRungRequestLine(rule: RuleGrantDraft): string {
  const dot = rule.targetPattern.lastIndexOf(".");
  const subject = rule.targetPattern.slice(0, dot);
  const action = rule.targetPattern.slice(dot + 1);
  const what = buildObjectActionTitle({
    action,
    objectKind: rule.targetProfile ?? subject,
  }).toLowerCase();
  const where = rule.scopeKind === "pod" ? " in every space" : "";
  return `Next time, let this agent ${what}${where} and tell you?`;
}

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
    throw noNextRung(
      "this item has no next rung to grant (a floor routed it, the write cannot be undone, its kind is unknown, it was declined, or no agent made it)."
    );
  }
  const { offer, rule } = projection;
  const filed = await fileRuleGrant({
    userId: params.userId,
    rule,
    mayGrant: params.mayGrant,
    fromProposalId: params.row.id,
  });
  return { ...filed, offer };
}

export type RuleGrantResult =
  | { outcome: "created"; ruleId: string }
  | { outcome: "already_covered"; ruleId: string }
  | { outcome: "proposed"; proposalId: string }
  | { outcome: "needs_admin"; proposalId: string };

/**
 * File ONE drafted `auto` rule — the shared back half of every "widen" door
 * (a card's next rung, a matrix cell's Widen). An identical active rule answers
 * `already_covered`. `mayGrant` (the caller's door decided it) writes the rule
 * now through `applyGovConfigChange`; otherwise a pending `settings.update` is
 * filed for the agent's OWNER, applied by that same write on approval.
 * `fromProposalId` is the card it was asked from (lineage), `null` when none.
 */
export async function fileRuleGrant(params: {
  userId: string;
  rule: RuleGrantDraft;
  mayGrant: boolean;
  fromProposalId: string | null;
}): Promise<RuleGrantResult> {
  const { rule } = params;
  const covering = (await findCoveringRules([rule])).get(ruleKey(rule));
  if (covering) {
    return { outcome: "already_covered", ruleId: covering };
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
      // LINEAGE: the card the person granted it from (none from the matrix).
      sourceProposalId: params.fromProposalId,
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
    return { outcome: "created", ruleId };
  }

  // Not the caller's to grant: the agent's OWNER decides (owner floor, 0248).
  const [agent] = await db
    .select({ createdByUserId: users.createdByUserId })
    .from(users)
    .where(eq(users.id, rule.agentUserId!))
    .limit(1);
  const owner = agent?.createdByUserId;
  if (!owner) {
    throw noNextRung("the agent has no owner to decide this.");
  }
  // The caller IS the owner and still may not grant it (a pod-wide rule needs
  // a pod admin): the same pending settings.update, which only a pod admin can
  // approve — reported as `needs_admin`, never "sent to the agent's owner" to
  // the owner themselves.
  const callerIsOwner = owner === params.userId;
  const { proposal, deduped } = await insertPendingProposal({
    workspaceId: null,
    targetType: "settings",
    targetId: rule.agentUserId!,
    proposalType: "settings.update",
    data: {
      store: "governance_rules",
      op: "set",
      ...spec,
      ...(params.fromProposalId
        ? { nextRungFromProposalId: params.fromProposalId }
        : {}),
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
          description: nextRungRequestLine(rule),
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
  return callerIsOwner
    ? { outcome: "needs_admin", proposalId: proposal.id }
    : { outcome: "proposed", proposalId: proposal.id };
}
