/**
 * THE TRUST LADDER — how much an agent needs the person for one kind of work,
 * and what the next step up would be (V1 F5, W7: "agents need you less every
 * week").
 *
 * Four rungs, lowest trust first (founder's proactive model, 2026-09-28):
 *
 *   ask      — "Ask me": a prepared question — a slot handed to the person
 *              (`ExpectedOutput.owner === 'human'`, the typed `ask`, carrying
 *              what the agent looked at).
 *   propose  — "Propose": the change is ready, one tap approves it — a
 *              proposal (pending, or one a person already settled).
 *   do_tell  — "Do + tell": the agent acted, the person sees it in Activity
 *              with Undo — an `auto_approved` receipt NO standing rule of the
 *              person's decided (the pod default "reversible writes act", or a
 *              default whitelist).
 *   quiet    — "Just do it": a RULE visible in Settings — an `auto_approved`
 *              receipt a specific `governance_rules` row decided (never the
 *              pod default's `@reversible` class row).
 *
 * The ladder INVENTS NO STATE. Every rung is read off fields already stored
 * (a slot's `owner`; a proposal's `status` / `proposalType` / `targetType`,
 * through the ONE attention rule `resolveProposalAttention`; a receipt's
 * `_autoApprove.governanceRuleId`, resolved by the server into
 * {@link TrustLadderItem} `grantedByRule`). A session-bookkeeping receipt (the
 * agent keeping its own session record, attention `history`) sits on NO rung:
 * it is not work done for the person.
 *
 * ## The next rung is a grant — only propose → do_tell in V1
 *
 * {@link NEXT_RUNG_VIA} says which config expresses each step. propose →
 * do_tell is the narrowest agent-scoped `auto` row in `governance_rules`
 * ({@link nextRungRuleDraft}), resolved at rung 2.8 of the ONE engine
 * (`decideAgentPolicy`): the next write of that kind acts, with Undo in
 * Activity. That is the ceiling of an OFFER in V1 (team-lead decision
 * 2026-09-28): do_tell → quiet is DEFERRED (it is the next ladder step to put
 * to the founder), and ask → propose has NO stored config ("stop asking me
 * this" — a param slot could pin its param on a playbook/track; not built).
 * {@link nextRung} offers nothing there rather than a button that does
 * nothing. The `quiet` RUNG is still READ (a receipt under the person's own
 * rule sits on it); only the offer to climb to it is withheld.
 *
 * ## Why the floors are an INPUT here, not a list
 *
 * A rule resolves BELOW every floor, so a grant offered on an item a floor
 * routed to review could never fire. Two facts decide that, and this package
 * copies neither:
 *   - REVERSIBILITY of the write (`@synap/governance-policy`
 *     `isReversibleWrite` — the engine's door class: destructive, scope,
 *     schema, structure, egress, effect and governance doors are all
 *     `disruptive`). The server computes it and passes {@link NextRungInput.reversible};
 *     absent means unknown, and unknown offers nothing.
 *   - WHICH RUNG routed the proposal (`proposals.governance_reason`, the
 *     engine's reason code). {@link GOVERNANCE_REASON_RULE_REACH} classifies
 *     every code the engine can emit; it is MIRRORED under a tripwire
 *     (`governance-policy/src/trust-ladder-reach.test.ts`) that asks the engine
 *     itself, so a new reason code fails the build of the test until someone
 *     classifies it — and the non-widenable floor set
 *     (`NON_WIDENABLE_GOVERNANCE_REASONS`) is asserted to sit inside `floor`.
 *
 * PURE and dependency-free at runtime.
 */

import {
  resolveProposalAttention,
  type ProposalAttentionInput,
} from "../proposals/attention.js";
import {
  isNonWidenableGovernanceReason,
  type GovernanceRuleDraft,
} from "../proposals/governance-grant-options.js";

// ─── Rungs ──────────────────────────────────────────────────────────────────

/** Lowest trust first. The ORDER is the ladder. */
export const TRUST_RUNGS = ["ask", "propose", "do_tell", "quiet"] as const;
export type TrustRung = (typeof TRUST_RUNGS)[number];

export function isTrustRung(value: unknown): value is TrustRung {
  return (
    typeof value === "string" && (TRUST_RUNGS as readonly string[]).includes(value)
  );
}

/** The rung one step above, or `null` for the top rung. */
export function rungAbove(rung: TrustRung): TrustRung | null {
  return TRUST_RUNGS[TRUST_RUNGS.indexOf(rung) + 1] ?? null;
}

// ─── Items ──────────────────────────────────────────────────────────────────

/**
 * One card, reduced to the fields that place it on the ladder.
 *
 * - `slot`: a session slot (`ExpectedOutput`). Only a HUMAN-owned slot is an
 *   ask; an agent-owned one asks nobody anything.
 * - `proposal`: a proposal row, pending or a receipt — the stored columns.
 */
export type TrustLadderItem =
  | { kind: "slot"; owner?: string | null }
  | ({
      kind: "proposal";
      /**
       * SERVER-RESOLVED, receipts only: a specific `governance_rules` row
       * (not the pod default's `@reversible` class row) executed this write —
       * `_autoApprove.governanceRuleId` looked up. Absent ⇒ not a rule grant.
       */
      grantedByRule?: boolean | null;
    } & ProposalAttentionInput);

/** Statuses that are the propose rung whatever a person later said. */
const PROPOSE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "approval_failed",
  "approved",
  "rejected",
  "withdrawn",
  "expired",
]);

/**
 * The rung an item sits on, or `null` when it sits on none.
 *
 * `null` for: an agent-owned slot; a status this build does not know (a newer
 * server than client — never guessed); `reverted`, which the status alone
 * cannot place (an Undo applies to a receipt AND to an approved proposal); and
 * a session-bookkeeping receipt (not work done for the person).
 */
export function resolveTrustRung(item: TrustLadderItem): TrustRung | null {
  if (item.kind === "slot") return item.owner === "human" ? "ask" : null;
  const status = item.status ?? "";
  if (PROPOSE_STATUSES.has(status)) return "propose";
  if (status !== "auto_approved") return null;
  // The ONE attention rule says whether this is work for the person at all —
  // bookkeeping is demoted to `history` there, never re-derived here.
  if (resolveProposalAttention(item) !== "notice") return null;
  return item.grantedByRule === true ? "quiet" : "do_tell";
}

// ─── What each step is granted through ──────────────────────────────────────

/** The config a next-rung grant writes. */
export type NextRungVia = "governance_rule";

/**
 * The config each step UP FROM a rung is granted through, or `null` when no
 * stored config expresses that step yet (see the file header). Keyed by the
 * rung the item is ON. `satisfies Record<TrustRung, …>`: a new rung that is
 * not classified here stops the build.
 */
export const NEXT_RUNG_VIA = {
  ask: null,
  propose: "governance_rule",
  // DEFERRED for V1 (team-lead, 2026-09-28): the offer ceiling is do_tell.
  do_tell: null,
  quiet: null,
} as const satisfies Record<TrustRung, NextRungVia | null>;

// ─── Governance reason codes → can a rule reach this item? ─────────────────

/**
 * How far an `auto` governance rule (rung 2.8) reaches for a proposal the
 * engine routed with this reason code:
 *
 *   - `floor`   — decided ABOVE rung 2.8 (admin, human gate, shell, schema,
 *                 structure, scope/identity, destructive, untrusted origin,
 *                 daily ceiling, observation-by-kind, per-capability and
 *                 per-channel governance). No rule can change it.
 *   - `rule`    — decided BY rung 2.8 (a `propose` rule). A more specific
 *                 `auto` rule outranks it.
 *   - `below`   — decided below rung 2.8 (the writes-require-proposal
 *                 switch). Any matching rule decides first.
 *   - `ambiguous` — the code is emitted both above and below 2.8, so the code
 *                 alone cannot say. Treated as `floor` (fail closed).
 *
 * Keys are EXACTLY `PROPOSE_REASON`'s keys (`@synap/governance-policy`) —
 * asserted by the reach tripwire, which also proves each `rule`/`below` code
 * flips to execute under an `auto` rule and each `floor` code does not.
 */
export const GOVERNANCE_REASON_RULE_REACH = {
  ADMIN: "floor",
  HUMAN_GATE: "floor",
  ARBITRARY_EXECUTION: "floor",
  POD_ADMIN_SCHEMA_CHANGE: "floor",
  AGENT_SCHEMA_DEFINITION: "floor",
  AGENT_STRUCTURE_WRITE: "floor",
  SCOPE_IDENTITY_CHANGE: "floor",
  DESTRUCTIVE_HARD_FLOOR: "floor",
  UNTRUSTED_ORIGIN: "floor",
  DAILY_WRITE_CEILING: "floor",
  USER_OBSERVATION_INFERENCE: "floor",
  CAPABILITY_PROPOSE: "floor",
  GOVERNANCE_RULE: "rule",
  AGENT_OWNED_DESTRUCTIVE: "floor",
  WRITES_REQUIRE_PROPOSAL: "below",
  CHANNEL_PROPOSE: "ambiguous",
} as const satisfies Record<string, "floor" | "rule" | "below" | "ambiguous">;

export type GovernanceReasonRuleReach =
  (typeof GOVERNANCE_REASON_RULE_REACH)[keyof typeof GOVERNANCE_REASON_RULE_REACH];

/**
 * Could an `auto` rule reach a proposal routed with this reason code?
 * `null`/absent = the engine's default fall-through (rung 9, no code), which
 * every rule outranks. An UNKNOWN code is `false`: never widen what the ladder
 * has not classified.
 */
export function ruleCanReachReason(code: string | null | undefined): boolean {
  if (code === null || code === undefined || code === "") return true;
  // The mirrored non-widenable set is checked first so the two mirrors can
  // never disagree in the widening direction.
  if (isNonWidenableGovernanceReason(code)) return false;
  if (!Object.prototype.hasOwnProperty.call(GOVERNANCE_REASON_RULE_REACH, code))
    return false;
  const reach =
    GOVERNANCE_REASON_RULE_REACH[
      code as keyof typeof GOVERNANCE_REASON_RULE_REACH
    ];
  return reach === "rule" || reach === "below";
}

// ─── The next rung ──────────────────────────────────────────────────────────

export interface NextRungInput {
  item: TrustLadderItem;
  /** `proposals.agent_user_id`. No agent ⇒ nobody to trust more ⇒ no offer. */
  agentUserId?: string | null;
  /** `proposals.governance_reason` — the engine's reason code, if any. */
  governanceReason?: string | null;
  /**
   * SERVER-DERIVED: `isReversibleWrite(eventKey)` from
   * `@synap/governance-policy`. The do+tell rung promises Undo, and a
   * disruptive write (destroy / scope / schema / structure / egress / effect /
   * governance) has none. Absent ⇒ unknown ⇒ no offer.
   */
  reversible?: boolean;
}

/** One step up, and the config that grants it. */
export interface NextRungOffer {
  from: TrustRung;
  to: TrustRung;
  via: NextRungVia;
}

/**
 * What accepting an offer did (`governanceRules.proposeNextRung`):
 *   created          — the caller may grant, so the rule was written now;
 *   already_covered  — an identical active rule already stands;
 *   proposed         — filed for the agent's owner to approve.
 * Words: `NEXT_RUNG_OUTCOME_LABELS` in the vocabulary.
 */
export const NEXT_RUNG_OUTCOMES = ["created", "already_covered", "proposed"] as const;
export type NextRungOutcome = (typeof NEXT_RUNG_OUTCOMES)[number];

/**
 * The next-rung offer for an item, or `null`.
 *
 * `null` when: the item sits on no rung; the rung is the top one; no config
 * expresses the step yet ({@link NEXT_RUNG_VIA}); or the grant could never
 * fire / must never be offered:
 *   - a proposal the person REJECTED, withdrawn, expired or failed — a "no"
 *     is not a reason to trust more (offered from `pending` and `approved`
 *     only);
 *   - no acting agent;
 *   - the write is not reversible (or reversibility is unknown);
 *   - a floor routed it ({@link ruleCanReachReason}).
 */
export function nextRung(input: NextRungInput): NextRungOffer | null {
  const from = resolveTrustRung(input.item);
  if (!from) return null;
  const to = rungAbove(from);
  const via = NEXT_RUNG_VIA[from];
  if (!to || !via) return null;
  // `via === "governance_rule"` ⇒ the item is a proposal (only `propose` has it).
  if (input.item.kind !== "proposal") return null;
  const status = input.item.status ?? "";
  if (status !== "pending" && status !== "approved") return null;
  if (!input.agentUserId) return null;
  if (input.reversible !== true) return null;
  if (!ruleCanReachReason(input.governanceReason)) return null;
  return { from, to, via };
}

// ─── The grant ──────────────────────────────────────────────────────────────

/**
 * The event key a proposal row was governed under.
 *
 * Receipts store a DOTTED `proposal_type` (`entity.create`); pending rows the
 * BARE verb (`create`) beside `target_type`. Prefixing the dotted form is how
 * `entity.entity.create` rules that no write matches were once minted.
 */
export function proposalEventKey(row: {
  targetType: string;
  proposalType: string;
}): string {
  return row.proposalType.startsWith(`${row.targetType}.`)
    ? row.proposalType
    : `${row.targetType}.${row.proposalType}`;
}

export interface NextRungRuleInput {
  /** The item the grant is made FROM — stored as the rule's lineage. */
  proposalId: string;
  agentUserId: string;
  /** The proposal's workspace; `null` ⇒ a pod-scope rule. */
  workspaceId?: string | null;
  /** `proposalEventKey(row)`. */
  eventKey: string;
  /**
   * The profile slug the GATE saw for this write (`data.profileSlug` on a
   * receipt, `data.data.profileSlug` on a pending row) — never a slug looked
   * up afterwards, or the rule narrows to a key the write never carries and
   * never fires.
   */
  profileSlug?: string | null;
}

/**
 * The NARROWEST rule that moves this item's kind of work up one rung: this
 * agent × this workspace (when there is one) × this exact action × this
 * profile (when the gate saw one), verdict `auto`.
 *
 * Narrowest is also STRONGEST at rung 2.8: specificity is additive (agent 2 +
 * workspace 2 + exact action on a profile 4), so this rule outranks any
 * broader `propose` row — including a posture — and, being newest, wins a tie.
 */
export function nextRungRuleDraft(
  input: NextRungRuleInput
): GovernanceRuleDraft {
  const workspaceId = input.workspaceId ?? undefined;
  return {
    principalKind: "agent",
    agentUserId: input.agentUserId,
    scopeKind: workspaceId ? "workspace" : "pod",
    ...(workspaceId ? { workspaceId } : {}),
    targetKind: "action",
    targetPattern: input.eventKey,
    ...(input.profileSlug ? { targetProfile: input.profileSlug } : {}),
    verdict: "auto",
    sourceProposalId: input.proposalId,
  };
}
