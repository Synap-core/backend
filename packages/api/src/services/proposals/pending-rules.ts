/**
 * Pending RULE proposals, shaped like rules — the read half of "a proposed
 * object must be visible to the doors that read that object".
 *
 * WHY THIS EXISTS. `createRuleGoverned` files an agent-authored rule as a
 * PROPOSAL; no `skills` row exists until a human approves it. Every rule read
 * door queries `skills`, so `synap rule list` answered **0** immediately after a
 * rule was proposed. The next agent, reading the same 0, proposes the SAME rule
 * again. The rule was not missing — it was invisible to the only door that could
 * have prevented the duplicate.
 *
 * WHAT THIS IS NOT. It is not a second rule store and it never merges silently
 * with real rows: every row it returns carries `status: "proposed"` and the
 * `proposalId` that would materialize it, and the read doors take it only behind
 * an explicit `includeProposed` opt-in (default OFF — a caller that expects only
 * approved rules must keep getting only approved rules).
 *
 * VISIBILITY. Two floors, both borrowed, neither invented:
 *   1. SQL — `userVisibleWhere(proposals.workspaceId, userId)`, the EXACT
 *      predicate `proposals.list` uses for the user-wide queue.
 *   2. JS — the scope tiers of `visibleSkillsWhere` mirrored onto the proposal's
 *      payload `scope`, because a proposed rule must never be MORE visible than
 *      the `skills` row it would become: `pod` is shared, `user` belongs to its
 *      proposer, `workspace` needs that workspace selected.
 * The scope lives in the JSONB payload, so tier 2 runs in JS over the (small)
 * pending set rather than as a JSONB predicate — same contract, no second
 * SQL dialect for the same rule.
 */

import {
  and,
  db,
  desc,
  eq,
  or,
  proposals,
  ProposalStatus,
  type SQL,
} from "@synap/database";

import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { authoredByUser } from "../agent-identity-service.js";
import {
  RULE_CATEGORY,
  buildRuleMetadata,
  readRuleRouting,
  readRuleScope,
  ruleNameFromIntent,
  type RuleBehaviourRecord,
  type RuleMetadata,
  type RuleRouting,
} from "../rules/index.js";
import { readExpiresAt } from "../rules/expiry.js";

/** `proposals.target_type` for a rule — stamped by `checkPermissionOrPropose`
 * from `subjectType: "rule"`. Same literal the rule's `skills.category` uses. */
const RULE_TARGET_TYPE = RULE_CATEGORY;

/**
 * A rule row that does not exist yet. Field-compatible with the approved rule
 * rows the same doors return, PLUS the two fields that make it unmistakable.
 */
export interface ProposedRuleRow {
  /** The id the rule WILL have (the gate stored it in the payload). Not a
   * `skills.id` yet — `getRule` on it 404s until the proposal is approved. */
  id: string;
  name: string;
  /** Always `false`: a proposed rule is by definition unapproved. */
  approved: boolean;
  workspaceId: string | null;
  createdAt: string;
  rule: RuleMetadata;
  /** The discriminator. Approved rows carry `"active"`. */
  status: "proposed";
  /** Review door: `synap open proposal <proposalId>`. */
  proposalId: string;
  /**
   * The structured WHEN/WHERE/THEN this rule will COMPILE INTO an automation,
   * when it has behaviour. Absent for a prose-only `fact` rule and for every
   * proposal filed before rules compiled at all.
   *
   * A reviewer approving a behavioural rule is authorizing a trigger that will
   * fire on its own; the prose says what the author MEANT, this says what will
   * actually be built. Kept `unknown` on purpose — rendering it is the surface's
   * job, and re-typing it here would be a second copy of the grammar.
   */
  sentence?: unknown;
}

/** The payload `createRuleGoverned` hands the gate. Every field is re-validated
 * here — a stored payload is data, not a contract.
 * Exported for unit tests: the DB half needs Postgres, this half does not. */
export function readRulePayload(data: unknown): {
  id: string;
  intent: string;
  scope: RuleMetadata["scope"];
  /** Absent when the rule never expires. */
  expiresAt?: string;
  factSkillId?: string;
  automationIds: string[];
  /** Absent for payloads written before the classifier was wired in. */
  routing?: RuleRouting;
  /**
   * The structured WHEN/WHERE/THEN, when this rule has behaviour. Left
   * `unknown`: this reader is the untrusted-payload boundary, and the sentence's
   * own schema (`services/rules/sentence-schema.ts`) is what parses it. Carried
   * onto `ProposedRuleRow` below so a reviewer's card can show what will be
   * BUILT, not only the prose — a field that reached no reader while a comment
   * claimed otherwise would be the exact severance this wave exists to close.
   */
  sentence?: unknown;
} | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const intent = typeof d.intent === "string" ? d.intent.trim() : "";
  if (!intent) return null;
  const routing = readRuleRouting(d.routing);
  // REPLAY OF AN OLD PAYLOAD: proposals filed before `trust` was dropped still
  // carry `d.trust`. It is simply not read — an unknown key in a JSONB blob is
  // inert, so nothing crashes and the removed field grants nothing on approval.
  const expiresAt = readExpiresAt(d.expiresAt);
  return {
    id: typeof d.id === "string" ? d.id : "",
    intent,
    scope: readRuleScope(d.scope),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof d.factSkillId === "string"
      ? { factSkillId: d.factSkillId }
      : {}),
    automationIds: Array.isArray(d.automationIds)
      ? d.automationIds.filter((a): a is string => typeof a === "string")
      : [],
    ...(routing ? { routing } : {}),
    ...(d.sentence !== undefined ? { sentence: d.sentence } : {}),
  };
}

/**
 * The JS half of the floor — `visibleSkillsWhere`'s three scope tiers, applied
 * to the rule scope carried in the proposal payload.
 */
export function scopeVisibleToCaller(
  scope: RuleMetadata["scope"],
  userId: string,
  proposerId: string | null,
  workspaceId?: string
): boolean {
  if (scope.kind === "pod") return true;
  if (scope.kind === "user") return proposerId === userId;
  // workspace: exactly `visibleSkillsWhere` — only when that workspace is the
  // selected lens. The SQL floor already proved membership.
  return !!workspaceId && scope.workspaceId === workspaceId;
}

export interface ListPendingRuleProposalsInput {
  userId: string;
  /** The selected workspace lens, if any. Mirrors `listRules`. */
  workspaceId?: string;
  limit?: number;
}

/**
 * Pending rule proposals visible to `userId`, newest first, shaped as rules.
 * Returns `[]` (never throws) when nothing is pending.
 */
export async function listPendingRuleProposals(
  input: ListPendingRuleProposalsInput
): Promise<ProposedRuleRow[]> {
  const conditions: SQL[] = [
    eq(proposals.targetType, RULE_TARGET_TYPE),
    eq(proposals.status, ProposalStatus.PENDING),
    // "Is a rule like this ALREADY pending?" — a question about the caller's own
    // filings, so LENS **or** OWNERSHIP. Floored on the lens alone, the caller's
    // own proposal in an unjoinable workspace was invisible and the next agent
    // re-proposed the same rule — the exact duplicate this file exists to stop.
    // `scopeVisibleToCaller` below still applies the pod/user/workspace tier.
    or(
      userVisibleWhere(proposals.workspaceId, input.userId),
      authoredByUser(input.userId)
    ) as SQL,
  ];

  const rows = await db.query.proposals.findMany({
    where: and(...conditions),
    orderBy: [desc(proposals.createdAt)],
    limit: input.limit ?? 50,
  });

  return rows.flatMap((row) => {
    const payload = readRulePayload(row.data);
    if (!payload) return [];
    const proposerId = row.proposedByUserId ?? row.createdBy ?? null;
    if (
      !scopeVisibleToCaller(
        payload.scope,
        input.userId,
        proposerId,
        input.workspaceId
      )
    )
      return [];

    // A proposed rule has taken NO divergence snapshot — the snapshot happens
    // at materialization. An empty `flowHash` says "not snapshotted yet"
    // honestly rather than fabricating a hash that would read as "matches".
    const behaviours: RuleBehaviourRecord[] = payload.automationIds.map(
      (automationId) => ({ automationId, flowHash: "" })
    );

    return [
      {
        id: payload.id || row.targetId,
        name: ruleNameFromIntent(payload.intent),
        approved: false as const,
        workspaceId: row.workspaceId ?? null,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : String(row.createdAt),
        rule: buildRuleMetadata({
          intent: payload.intent,
          scope: payload.scope,
          ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}),
          ...(payload.factSkillId ? { factSkillId: payload.factSkillId } : {}),
          behaviours,
          // Same routing the approved rule will carry — a pending rule must
          // not read as "unclassified" and then acquire a shape on approval.
          ...(payload.routing ? { routing: payload.routing } : {}),
          // ⚠️ INSIDE `rule`, where a MATERIALIZED row carries it.
          //
          // This used to be set at the row's TOP LEVEL, one line below. Both
          // shapes ship in the same array from `skills.listRules`, so a client
          // reading `row.rule.sentence` — which is where `readRuleMetadata`
          // projects it for every approved rule — found nothing on a proposed
          // one. Net effect: the dry-run panel said "this rule's WHEN was not
          // stored" for exactly the rules that DO carry a sentence, since the
          // proposal payload is where it has always lived.
          //
          // One shape, one slot. `buildRuleMetadata` already accepts it.
          ...(payload.sentence !== undefined
            ? { sentence: payload.sentence }
            : {}),
          now: row.createdAt instanceof Date ? row.createdAt : undefined,
        }),
        status: "proposed" as const,
        proposalId: row.id,
      },
    ];
  });
}
