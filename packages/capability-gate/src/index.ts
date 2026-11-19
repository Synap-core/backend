/**
 * Capability-execution gate helper — WIRED (enabled state + approval row).
 *
 * The single resolution point that turns "an agent wants to RUN this
 * capability" into a governance verdict. It composes TWO signals:
 *
 *   (a) the capability's ENABLED state    → `capabilityGovernance`
 *       (from the tool/skill row's `approved` column)
 *   (b) the APPROVAL ROW (`governance_rules`, target `capability`) that best
 *       matches this agent × this action (or its tool) × this space — the
 *       ONLY answer to "may this run without asking?" (founder decisions D2
 *       and D3, 19 Nov 2026, document b387ca45). Order: the floors, then the
 *       ranked rows (a "Never" refuses; an "auto" runs; an "ask first" or no
 *       row asks). A capability grant (`vault_grants`) means only "may use"
 *       (scope, expiry, uses): the gate never reads it, and its retired
 *       `exec_mode` became approval rows (migration 0434).
 *
 * It does DB READS (the tool/skill row when not passed in, the approval rows)
 * but performs NO writes. A grant's use-count is consumed separately at the
 * dispatch point, only when the final verdict is `run` (see
 * external-dispatch.ts).
 *
 * It IS wired into the IS→backend capability-execute chokepoint
 * (`triggerProviderAction` in external-dispatch.ts). It no-ops for the operator
 * door (no `agentUserId`) and for owner runs.
 *
 * Owner bypass: when `actorUserId` owns the capability AND the run is not an agent
 * run (mirrors the vault owner-bypass philosophy — a genuine human owner is never
 * gated on an approval row for their OWN capability), the verdict is always `run`.
 *
 * Part of the Playbooks & Capability Substrate (G4 — per-capability governance).
 *
 * HOME: this lives in `@synap/capability-gate` — a thin package depending ONLY on
 * `@synap/database` (approval-row resolver + tool/skill rows) and `@synap/governance-policy`
 * (the pure decision core). Both `@synap/api` AND `@synap/jobs` import it, so the
 * automation door (jobs) can run the FULL gate instead of an approved-only check.
 * It is NOT in `@synap/governance-policy` because that package is the PURE, I/O-free
 * decision core — adding DB reads there would break that invariant. It is NOT in
 * `@synap/api` because `@synap/jobs` cannot import api (api → jobs already, a cycle).
 */

import {
  getDb,
  eq,
  and,
  gte,
  ne,
  drizzleSql,
  getRequestGrant,
} from "@synap/database";
import {
  resolveCeiling,
  resolveGovernanceRule,
  resolveOriginTrust,
  type GovernanceRuleMatch,
} from "@synap/database/agent-governance";
import {
  tools,
  skills,
  capabilityIntents,
  computeLeases,
} from "@synap/database/schema";
import {
  capabilityVerbAllowsRuleWiden,
  decideAgentPolicy,
  DENIED_BY_RULE,
  DENIED_BY_RULE_REASON,
} from "@synap/governance-policy";
import {
  TRIAL_RUN_WRITE_REFUSED,
  trialSessionWriteRefusal,
} from "./trial-session.js";

export {
  TRIAL_RUN_WRITE_REFUSED,
  TRIAL_RUN_WRITE_REFUSED_REASON,
  trialStampOf,
  trialSessionWriteRefusal,
  type TrialSessionStamp,
} from "./trial-session.js";

/** The grantable kinds a capability run can target. */
export type CapabilityRunKind = "tool" | "skill" | "command";

/**
 * Minimal row shapes the gate reads `approved`/owner from. Callers may pass the
 * already-loaded row to avoid a re-read; otherwise the gate loads it by id.
 */
export interface GateToolRow {
  id: string;
  approved: boolean | null;
  /** Owner principal — `tools.created_by`. */
  createdBy: string | null;
  /**
   * The tool's stable NAME (`tools.name`) — this IS the verbId a capability
   * rule's `target_pattern` matches against (execute-capability.ts: "verbId =
   * backing skill/tool NAME"). Optional because some callers pre-load a row
   * without it (e.g. connector-import-bridge's synthetic tool row); absent →
   * a rule can only match by the (reinstall-unstable) row id.
   */
  name?: string | null;
}
export interface GateSkillRow {
  id: string;
  approved: boolean | null;
  /** Owner principal — `skills.user_id`. */
  userId: string | null;
  /**
   * The skill's stable NAME (`skills.name`) — this IS the verbId (see
   * `GateToolRow.name`). Optional for the same pre-load reason.
   */
  name?: string | null;
  /**
   * The intent the verb serves (`skills.intent`, the authority). Read by the
   * app outward floor only; absent (not pre-loaded) → the gate reads it when
   * that floor needs it, `null` = the verb declares none.
   */
  intent?: string | null;
  /**
   * The skill's `metadata` bag: its declared `proposeOnly` (no auto approval
   * row ever runs it) is read from here. Absent (not pre-loaded) →
   * the gate reads it when a widening is decided, never assumes none.
   */
  metadata?: Record<string, unknown> | null;
}

export interface GateCapabilityExecutionInput {
  capabilityKind: CapabilityRunKind;
  capabilityId: string;
  /** Pre-loaded tool row (skips the DB read) when kind === "tool". */
  tool?: GateToolRow | null;
  /** Pre-loaded skill row (skips the DB read) when kind === "skill". */
  skill?: GateSkillRow | null;
  /** The human/agent principal performing the run (for owner-bypass). */
  actorUserId: string;
  /** The agent identity, when the run is agent-initiated. */
  agentUserId?: string | null;
  /**
   * READ-ONLY capability marker — set for a capability whose execution only
   * READS (no mutation). Mirrors execute-provider-verb's `isReadMethod →
   * alreadyApproved:true`: a read is not a mutation, so once it clears the
   * APPROVAL gate it never needs an approval row and never proposes — its scope is
   * enforced downstream by the access layer (caller's row floor), NOT by this
   * governance gate. Builtin verbs have no HTTP method, so the caller
   * (executeCapability) sets this explicitly from the read-verb set. Absent
   * (the normal case) → the full approval-row ladder applies. It NEVER weakens
   * the approval gate above (an unapproved read is still denied).
   */
  readOnly?: boolean;
  /**
   * The run carries at least one POD FILE to the verb's tool (a declared
   * `file:url` parameter the call fills: `file-parameters.ts` in the api).
   * Set server-side by the run door from the verb's declaration, never from
   * request fields. An agent's or an app's run that carries one always
   * proposes (POD_FILE_OUTWARD, decision 7d42be8c); tighten-only.
   */
  carriesPodFiles?: boolean;
  workspaceId?: string | null;
  sessionId?: string | null;
  playbookId?: string | null;
  /**
   * The acting channel id, when this run happens in a channel context. Threaded
   * to the #4 instruction-provenance origin-trust resolver (`resolveOriginTrust`):
   * an untrusted-origin channel (EXTERNAL / bridge / `source`) force-proposes the
   * run — it can never auto-run via an "auto" capability OR an "auto"
   * approval row (tighten-only, owner-approved). Set it server-side from the
   * routing/turn seam, never from request-body fields; absent → no channel
   * context → the origin-trust signal no-ops.
   */
  channelId?: string | null;
  /** Free-text issuer label (channel / hub door) for audit; not yet consumed. */
  issuer?: string | null;
  /**
   * Effective per-channel capability grant when the run happens inside a
   * multiplayer channel — passed straight through so rung 2.7's tightening
   * invariant (a channel grant may only narrow an "auto" capability) applies.
   */
  channelCapabilities?: {
    canDraft: boolean;
    canPropose: boolean;
    canAct: boolean;
  } | null;
  /**
   * The run is an INTENT ACTION (an action the pod listed for an intent,
   * asked for through the intent form of `POST /capabilities/execute`), by
   * any caller: an agent drafting for the person, not only a pod app. An
   * outward one always files a proposal (decision 790baeb5, founder
   * 2026-10-28: the AI proposes sends, the person approves them), which is
   * what the listed action promises (`governance: "propose"`). Tighten-only.
   */
  intentRun?: boolean;
  /**
   * The spend maximum (`maxSpendCents`) of a COMPUTE START (a
   * `provision_compute` verb), set server-side by the run door from the
   * checked parameters; absent for every other run. An agent's start that
   * would run is proposed instead when it takes the day's started maximums
   * past the `compute_spend_daily_cents` ceiling (0430; opt-in, no limit by
   * default): COMPUTE_SPEND_CEILING. Tighten-only.
   */
  computeSpendCents?: number | null;
}

/** The proposal target/type a `propose` verdict materializes against. */
export const CAPABILITY_RUN_PROPOSAL = {
  targetType: "capability",
  proposalType: "run",
} as const;

export type GateCapabilityDecision =
  | { decision: "run" }
  | {
      decision: "propose";
      proposalType: string;
      data: Record<string, unknown>;
      /**
       * WHY this run needs a human — a `PROPOSE_REASON` key, persisted onto
       * `proposals.governance_reason` by the caller.
       *
       * Without it a capability-run proposal reaches review with NO recorded
       * cause, and since the fingerprint keys on `targetId` (the capability)
       * an untrusted-origin run is INDISTINGUISHABLE from a routine one inside
       * a cluster of 400. Measured 2026-09-01: 620 of 680 pending rows carried
       * no reason at all, because this field did not exist.
       *
       * Optional so every existing consumer of the propose branch compiles
       * unchanged.
       */
      reasonCode?: string;
    }
  /**
   * `reasonCode` = a typed refusal the caller branches on: `DENIED_BY_RULE`
   * (a person's "Never" on this capability for this agent). Absent for the
   * approval and policy denials, which carry only their sentence.
   */
  | { decision: "deny"; reason: string; reasonCode?: string }
  /**
   * No longer produced: it came only from a grant's `dry-run` exec mode,
   * retired by 0434 (decision D2). Kept so the callers' preview branches
   * (13 of them across api and jobs) are retired in their own change.
   */
  | { decision: "dry-run" };

/**
 * Resolve the governance verdict for executing a capability.
 *
 * Resolution order:
 *   0. The floors, each tighten-only: not enabled (`approved === false`)
 *      → deny, for everyone; a person's "Never" (a `deny` row) → deny; an
 *      untrusted origin, a pod file leaving, a trial session, an app's or an
 *      intent's outward run → propose (or refuse). A declared read runs.
 *   1. Owner bypass — a GENUINE human owner run (`actorUserId` owns the
 *      capability AND no `agentUserId`) → `run`. An agent under the owner's
 *      identity is NOT owner-bypassed.
 *   2. THE APPROVAL ROW — for an agent run, the best-ranked active
 *      `governance_rules` capability row (`resolveCapabilityRule`, one read
 *      per run): this agent (2) > its class (1) > anyone (0), plus a space
 *      row (2) over a pod row (0), plus a row naming the action (3) over a
 *      row naming its tool (2); on a tie the stricter verdict wins. `auto`
 *      → the policy's capability rung (2.7) with exec mode `auto` (a
 *      propose-only action still asks; the channel rung 7 is NOT applied,
 *      as it never was to an auto rule);
 *      `propose` or no row → propose (the posture default for a tool run).
 *      Grants are never read: a grant means "may use", not "without asking".
 *   3. A run with no agent (a person who is not the owner) keeps the policy's
 *      enabled-state answer (`approved` → run).
 *
 * Reads the one tool/skill row (when not pre-loaded) + (for an agent run)
 * ONE `governance_rules` lookup, from which both the "Never" refusal and the
 * "auto" derive. NO writes.
 *
 * A capability rule MAY be keyed on the row `capabilityId`, which a reinstall
 * re-creates with a new id (`execute-capability.ts:124-129`): a row authored
 * against the old id alone stops matching after a reinstall. Rules are ALSO
 * matchable by the capability's stable VERB NAME (`tools.name`/`skills.name`,
 * = `verbId`), which survives a reinstall — author "always approve this
 * action" rows against the verb name. The rows 0434 made from grants name the
 * row id, exactly what each grant matched.
 */
/**
 * The ONE approval predicate: approval refuses a run of this tool/skill row.
 *
 * Step 0 of `gateCapabilityExecution` below denies on exactly this, and the
 * capability catalogue (`capability-registry.ts`, `backingSkillExecutable` and
 * each verb's `blocked: "not_enabled"`) reads the SAME function, so discovery
 * can never call a verb ready that the run door then refuses as "installed but
 * not yet enabled" (ticket 509c9358). `null` = no approval concept (commands).
 */
export function approvalRefusesRun(row: {
  approved: boolean | null | undefined;
}): boolean {
  return row.approved === false;
}

export async function gateCapabilityExecution(
  input: GateCapabilityExecutionInput
): Promise<GateCapabilityDecision> {
  const decision = await decideCapabilityExecution(input);
  // ── COMPUTE SPEND CEILING (0430, founder 18 Nov 2026) — an agent's compute
  //    start that would RUN (an auto approval row) is proposed instead
  //    when the day's started maximums plus this one pass the ceiling. Last,
  //    so it only ever turns a `run` into a review: tighten-only, like every
  //    axis. A person's own start is theirs to make.
  if (
    decision.decision === "run" &&
    input.agentUserId &&
    typeof input.computeSpendCents === "number" &&
    (await computeSpendPassesCeiling(input, input.computeSpendCents))
  ) {
    return buildProposeDecision(input, COMPUTE_SPEND_CEILING);
  }
  return decision;
}

/** `proposals.governance_reason` of a start the compute spend ceiling proposed. */
export const COMPUTE_SPEND_CEILING = "COMPUTE_SPEND_CEILING";

/** Start of the current UTC day. */
function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

/**
 * Would this start take the day's compute past the ceiling? The day's
 * started maximums (`compute_leases.max_spend_cents`, every start since UTC
 * midnight that did not fail to start) plus this one, against the resolved
 * `compute_spend_daily_cents` (null = no limit: never).
 */
async function computeSpendPassesCeiling(
  input: GateCapabilityExecutionInput,
  spendCents: number
): Promise<boolean> {
  const db = await getDb();
  const ceiling = await resolveCeiling({
    db,
    axis: "compute_spend_daily_cents",
    agentUserId: input.agentUserId ?? null,
    workspaceId: input.workspaceId ?? null,
  });
  if (ceiling.value === null) return false;
  const [row] = await db
    .select({
      total: drizzleSql<number>`coalesce(sum(${computeLeases.maxSpendCents}), 0)::int`,
    })
    .from(computeLeases)
    .where(
      and(
        gte(computeLeases.createdAt, startOfUtcDay(new Date())),
        ne(computeLeases.state, "not_started")
      )
    );
  return Number(row?.total ?? 0) + spendCents > ceiling.value;
}

async function decideCapabilityExecution(
  input: GateCapabilityExecutionInput
): Promise<GateCapabilityDecision> {
  // ── (a) load approval-state + owner ─────────────────────────────────────────
  let approved: boolean | null = null;
  let ownerId: string | null = null;
  // The capability's stable NAME (= verbId) — threaded into the capability-rule
  // lookup below so a rule can target the verb name (reinstall-stable) instead
  // of only the row id (reinstall-unstable). `null` for commands (no row) or a
  // pre-loaded row that omitted `name`.
  let verbName: string | null = null;
  // What the verb declares about widening (a skill only; a field left
  // `undefined` = not loaded yet): a propose-only intent (a public post) or a
  // declared `metadata.proposeOnly` is never widened by an auto approval
  // row, whatever the verb is named (`capabilityVerbAllowsRuleWiden`).
  let knownPosture: Partial<VerbPosture> = { intent: null, metadata: null };

  if (input.capabilityKind === "tool") {
    let row = input.tool ?? null;
    if (!row) {
      const db = await getDb();
      const [loaded] = await db
        .select({
          id: tools.id,
          approved: tools.approved,
          createdBy: tools.createdBy,
          name: tools.name,
        })
        .from(tools)
        .where(eq(tools.id, input.capabilityId));
      row = loaded ?? null;
    }
    approved = row?.approved ?? null;
    ownerId = row?.createdBy ?? null;
    verbName = row?.name ?? null;
  } else if (input.capabilityKind === "skill") {
    let row = input.skill ?? null;
    if (!row) {
      const db = await getDb();
      const [loaded] = await db
        .select({
          id: skills.id,
          approved: skills.approved,
          userId: skills.userId,
          name: skills.name,
          intent: skills.intent,
          metadata: skills.metadata,
        })
        .from(skills)
        .where(eq(skills.id, input.capabilityId));
      row = loaded ?? null;
    }
    approved = row?.approved ?? null;
    ownerId = row?.userId ?? null;
    verbName = row?.name ?? null;
    knownPosture = row
      ? { intent: row.intent, metadata: row.metadata }
      : { intent: null, metadata: null };
  } else {
    // commands have no approved/owner column today → conservative defaults.
    approved = null;
    ownerId = null;
  }

  // ── 0. APPROVAL GATE (applies to EVERYONE, including the owner — mirrors the
  //       MCP `approved` hard gate). A draft/unapproved tool or skill must NOT run
  //       for anyone; the owner approves it (setApproved) — or dry-runs to test —
  //       FIRST. Owner-bypass below skips the GRANT requirement, never approval.
  //       `approved === null` = no approval concept (commands) → not gated here.
  if (approvalRefusesRun({ approved })) {
    return {
      decision: "deny",
      // NOTE: the gate stays write-free. For an AGENT caller, the api's execute
      // door turns this deny into ONE `capability.enable` proposal for the pack
      // (`proposeCapabilityEnable`, services/capabilities/propose-capability-enable.ts).
      // The reason text below is what a human caller still reads.
      reason:
        "This capability is installed but not yet enabled. Ask the user to enable it (Tools), or run with dryRun to preview.",
    };
  }

  // Read only when a widening is about to be decided; a row pre-loaded
  // without its intent or metadata is read, never assumed to have none.
  let postureRead: Promise<VerbPosture> | null = null;
  const verbPosture = (): Promise<VerbPosture> =>
    (postureRead ??= readVerbPosture(input, knownPosture));

  // The capability rule for this agent run, read ONCE: the "Never" check
  // below and both widening checks further down derive their answer from it.
  const rule = await resolveCapabilityRule(input, verbName);

  // ── 0.2 A PERSON'S "NEVER" (a founder decision, 0381) — an agent run of a
  //       capability a `deny` rule names (this agent, or any agent, by verb
  //       name or row id) is refused, typed, before every other rung: refusing
  //       is stricter than any floor below, and a read is refused too (the
  //       person said never for this capability, not "never write"). Ranked by
  //       the resolver's specificity score, deny winning ties.
  if (rule?.verdict === "deny") {
    return {
      decision: "deny",
      reason: DENIED_BY_RULE_REASON,
      reasonCode: DENIED_BY_RULE,
    };
  }

  // ── 0.5 ORIGIN TRUST — resolved BEFORE the read-only short-circuit.
  //
  // WHY IT MOVED (2026-09-20): it used to sit below, on the reasoning that
  // "owner/read-only runs already returned above and are unaffected". That was
  // safe only while `readOnly` meant a BUILTIN read (a local hub op) or a
  // GET/HEAD provider call. The authored `metadata.readOnly` declaration widened
  // it to any verb whose definition claims it — including `exa_search`, a
  // `kind:"code"` verb that makes an outbound HTTP POST carrying a
  // CALLER-SUPPLIED body.
  //
  // The attack that opened: content arriving on an untrusted bridge/EXTERNAL
  // channel prompt-injects the agent into `exa_search({query: "<pod content>"})`.
  // Under the old order that force-proposed; with the short-circuit above the
  // rung it would have auto-run, shipping pod text to a third party with no
  // human in the loop. `readOnly` means "does not mutate POD state" — it has
  // never meant "no external effect", and this wave made that split explicit by
  // returning false from `capabilityVerbHasExternalEffect` for the same verbs.
  //
  // Only agent runs are classified; absent channelId → undefined → no downgrade,
  // so operator and unchannelled runs pay nothing.
  const originTrust = input.agentUserId
    ? await resolveOriginTrust({
        db: await getDb(),
        channelId: input.channelId,
        userId: input.actorUserId,
        workspaceId: input.workspaceId ?? null,
        capabilityId: input.capabilityId,
      })
    : undefined;

  // ── 0.7 POD FILE FLOOR (decision 7d42be8c, founder 2026-10-28) — a run that
  //       hands one of the person's pod files to a tool, asked for by an AGENT
  //       or through a POD APP's credential, ALWAYS files a proposal: a file
  //       leaving the pod is a commitment the person confirms. It precedes the
  //       read-only short-circuit (a file verb is refused `readOnly` at install,
  //       but a verb authored elsewhere could claim it), the owner bypass (a
  //       person token resolves as the person) and the approval rows (an
  //       auto row must not widen it). The person's own run
  //       in the pod (no agent, no app) is untouched. Tighten-only.
  if (
    input.carriesPodFiles &&
    (input.agentUserId || getRequestGrant()?.clientId)
  ) {
    return buildProposeDecision(input, POD_FILE_OUTWARD);
  }

  // ── READ-ONLY short-circuit — mirrors execute-provider-verb's
  //    `isReadMethod → alreadyApproved:true`. A read is not a mutation: once it
  //    clears the APPROVAL gate above, it never needs an approval row and never proposes.
  //    Its SCOPE is enforced downstream by the access layer (the caller's row
  //    floor), not by this governance gate — so a read can never leak
  //    cross-workspace rows here, and can never spawn a proposal. Applies to
  //    EVERY caller (operator AND agent), which is why it precedes owner-bypass
  //    and the approval rows. WRITES leave `readOnly` unset and fall
  //    through to the full ladder below.
  //
  // ⚠️ IT DOES **NOT** BYPASS ORIGIN TRUST. Resolved above, and an untrusted
  // origin force-proposes even a declared read — see the block just above for
  // why (a read that carries a caller-supplied body outward is an exfiltration
  // channel, not a harmless lookup).
  if (input.readOnly) {
    if (originTrust === "untrusted") {
      return buildProposeDecision(input, "UNTRUSTED_ORIGIN");
    }
    return { decision: "run" };
  }

  // ── 0.8 TRIAL RUN (design b199a3a4, slice 1b) — a run inside a trial
  //       session (the rule lab) is refused unless it is a declared read
  //       (returned above): nothing a trial does may land, for any caller,
  //       whatever an approval row would say. A session that cannot be read
  //       refuses (fail closed). Tighten-only.
  const trialRefusal = await trialSessionWriteRefusal(input.sessionId);
  if (trialRefusal) {
    return {
      decision: "deny",
      reason: trialRefusal,
      reasonCode: TRIAL_RUN_WRITE_REFUSED,
    };
  }

  // ── 0.9 APP OUTWARD FLOOR (decision 4A, founder 2026-10-28) — a run asked
  //       for through a POD APP's credential on a verb that reaches outside the
  //       pod ALWAYS files a proposal: the person's approval in their pod is the
  //       confirmation, for every app. It precedes the owner bypass on purpose:
  //       a `synap_acts_as: person` token resolves as the person (no
  //       agentUserId), so the bypass below would run a publish with no review.
  //       Tighten-only; a declared read returned above.
  //       An intent action asked for by any other caller (an agent's key)
  //       meets the same floor (`intentRun`, decision 790baeb5).
  const outward = await outwardRunMustPropose(input, verbPosture);
  if (outward) {
    return buildProposeDecision(input, outward);
  }

  // ── 1. Owner bypass — only a GENUINE human owner run (no agentUserId) skips the
  //       approval rows. An agent acting under the owner's identity meets them.
  const isOwnerRun =
    !input.agentUserId &&
    !!ownerId &&
    !!input.actorUserId &&
    ownerId === input.actorUserId;
  if (isOwnerRun) {
    return { decision: "run" };
  }

  // ── 1.5 ORIGIN TRUST — RESOLVED AT 0.5 above (it must precede the read-only
  //       short-circuit). An untrusted-origin channel force-proposes: it can
  //       NEVER auto-run via an "auto" approval row or an "auto" capability.
  //       Owner runs returned above and are unaffected.
  const originUntrusted = originTrust === "untrusted";

  // ── 2. THE APPROVAL ROW (decisions D2/D3) — the ONLY answer to "may this
  //       agent run this without asking?". An `auto` row (resolved once above,
  //       ranked, the stricter verdict winning a tie) sends the run through
  //       the policy's capability rung with exec mode `auto`; an "ask first"
  //       row or no row proposes. A grant is not read: it means "may use",
  //       never "without asking".
  //       CHANNEL RUNG 7 IS NOT APPLIED to an auto row: an auto rule never met
  //       it before 0434, and with `can_act = false` on nearly every agent
  //       membership (founder's pod, 19 Nov 2026: 4001 memberships in 2060
  //       channels) applying it would stop auto rules in most rooms. Kept as
  //       before by the lead's default (W1, D2 review); the founder decides
  //       at review. No caller passes `channelCapabilities` today either.
  let approvalMode: "auto" | null = null;
  if (input.agentUserId) {
    if (originUntrusted) {
      return buildProposeDecision(input, "UNTRUSTED_ORIGIN");
    }
    if (!(await capabilityRuleAuthorizesRun(rule, verbName, verbPosture))) {
      return buildProposeDecision(input, "CAPABILITY_PROPOSE");
    }
    approvalMode = "auto";
  }

  // ── 3. derive the enabled-state signal ──────────────────────────────────────
  const capabilityGovernance: "auto" | "propose" = approved
    ? "auto"
    : "propose";

  // ── 4. delegate to the pure decision core (capability rung 2.7) ─────────────
  const verdict = decideAgentPolicy({
    subjectType: CAPABILITY_RUN_PROPOSAL.targetType,
    action: CAPABILITY_RUN_PROPOSAL.proposalType,
    capabilityGovernance,
    capabilityExecMode: approvalMode,
    // An auto approval row skips the channel rung (see step 2); a person's
    // run with no row keeps it, as before.
    channelCapabilities:
      approvalMode === "auto"
        ? undefined
        : (input.channelCapabilities ?? undefined),
    // #4: an untrusted origin downgrades a would-be-auto run to propose at rung
    // 2.55 (above the capability rung 2.7) inside the pure engine.
    originTrust,
  });

  if (verdict.verdict === "execute") {
    return { decision: "run" };
  }
  if (verdict.verdict === "deny") {
    return { decision: "deny", reason: verdict.reason };
  }
  // The verdict carries the structured cause (the policy emits
  // UNTRUSTED_ORIGIN / CHANNEL_PROPOSE / CAPABILITY_PROPOSE itself).
  return buildProposeDecision(
    input,
    verdict.reasonCode ?? "CAPABILITY_PROPOSE"
  );
}

/** `proposals.governance_reason` of a run the app outward floor proposed. */
export const APP_OUTWARD_INTENT = "APP_OUTWARD_INTENT";
/** The same floor, for an intent action no app asked for (an agent's key). */
export const INTENT_OUTWARD = "INTENT_OUTWARD";

/**
 * Must this run be proposed because a pod app asked for it, or because it is
 * an intent action, and it reaches outside the pod? The reason it records,
 * or null. The app is the request's grant `clientId` (an app's public id;
 * null for a bare key), set by the key-auth doors for an app's agent key AND
 * a person token alike — so the person's own use in the pod (no grant) and a
 * personal key never meet this floor, unless they ask for an intent action
 * (`intentRun`).
 */
async function outwardRunMustPropose(
  input: GateCapabilityExecutionInput,
  verbPosture: () => Promise<VerbPosture>
): Promise<typeof APP_OUTWARD_INTENT | typeof INTENT_OUTWARD | null> {
  const reason = getRequestGrant()?.clientId
    ? APP_OUTWARD_INTENT
    : input.intentRun
      ? INTENT_OUTWARD
      : null;
  if (!reason) return null;
  return (await isOutward(input, verbPosture)) ? reason : null;
}

/** `proposals.governance_reason` of a run the pod file floor proposed. */
export const POD_FILE_OUTWARD = "POD_FILE_OUTWARD";

/**
 * Outward = the verb's intent has an effect other than `read` in
 * `capability_intents` (a write or an act changes, sends or spends something
 * the pod cannot call back). Fail closed: a verb with no intent, an intent
 * with no row, and a raw tool call (no verb, so no intent) are outward. The
 * intent is the run's one posture read (`verbPosture`).
 */
async function isOutward(
  input: GateCapabilityExecutionInput,
  verbPosture: () => Promise<VerbPosture>
): Promise<boolean> {
  if (input.capabilityKind !== "skill") return true;
  const { intent } = await verbPosture();
  if (!intent) return true;
  const db = await getDb();
  const [declared] = await db
    .select({ effect: capabilityIntents.effect })
    .from(capabilityIntents)
    .where(eq(capabilityIntents.slug, intent));
  return declared?.effect !== "read";
}

/**
 * The stored `governance_rules` `target_kind: "capability"` row that governs
 * this agent's run of this capability, read ONCE per run: a `deny` refuses it
 * (step 0.2), an `auto` may widen it (`capabilityRuleAuthorizesRun`). One read
 * means one ranking: a more specific `auto` outranks a broad deny, and a deny
 * wins a tie (`resolveGovernanceRule`). `undefined` for a non-agent run, a
 * secret, or no matching active rule.
 *
 * Scoped to grantable kinds ONLY: `input.capabilityKind` is typed
 * `CapabilityRunKind` ("tool" | "skill" | "command"), which never includes
 * `"secret"` — so this can never be reached for, and can never authorize, a
 * secret decrypt.
 *
 * `verbName` (the capability's stable `tools.name`/`skills.name`) is passed
 * through to `resolveGovernanceRule` alongside `capabilityId` so a rule
 * authored against the VERB NAME (reinstall-stable) matches equally to one
 * authored against the row id (reinstall-unstable, the KNOWN LIMITATION
 * above) — see `scoreRuleTarget`'s `targetKind: "capability"` branch.
 */
async function resolveCapabilityRule(
  input: GateCapabilityExecutionInput,
  verbName: string | null
): Promise<GovernanceRuleMatch | undefined> {
  if (!input.agentUserId) return undefined;
  // Defence-in-depth: `input.capabilityKind` is typed `CapabilityRunKind`
  // ("tool" | "skill" | "command"), which structurally excludes "secret" —
  // this runtime guard holds even against a future type widening or an
  // `as` cast, so a rule can never be consulted for a secret grantable.
  if ((input.capabilityKind as string) === "secret") return undefined;
  return resolveGovernanceRule({
    db: await getDb(),
    agentUserId: input.agentUserId,
    workspaceId: input.workspaceId ?? null,
    subjectType: CAPABILITY_RUN_PROPOSAL.targetType,
    action: CAPABILITY_RUN_PROPOSAL.proposalType,
    capabilityId: input.capabilityId,
    capabilityVerbName: verbName,
    // The tools this action belongs to: a row naming the tool covers it (D3).
    capabilityKind: input.capabilityKind,
  });
}

/**
 * Does the run's approval row let it run without asking? Option B / D1
 * (ratified 2026-07-27, phase 2 D1): an ACTIVE `verdict: "auto"` row
 * authorizes it, grant or no grant; since D2 (document b387ca45) it is the
 * only thing that does. Never asked for the `approved === false` deny floor,
 * checked strictly before, so a rule can never resurrect a disabled
 * capability.
 *
 * Only a rule that NAMES this capability can authorize the run: the resolver
 * skips every broad `auto` row (`*`, a glob, the generic `capability.run`
 * action) for a capability run (`NAMED_RULE_ONLY_EVENT_KEYS`, the outward
 * floor), so "Everything, always" never sends a message on its own.
 */
async function capabilityRuleAuthorizesRun(
  rule: GovernanceRuleMatch | undefined,
  verbName: string | null,
  verbPosture: () => Promise<VerbPosture>
): Promise<boolean> {
  if (rule?.verdict !== "auto") return false;
  // A public post or a declared propose-only verb stays a proposal even when
  // a lane rule says auto.
  return verbAllowsWiden(verbName, await verbPosture());
}

/** What a verb declares about widening: its intent and its metadata bag. */
interface VerbPosture {
  intent: string | null;
  metadata: Record<string, unknown> | null;
}

function verbAllowsWiden(verbName: string | null, p: VerbPosture): boolean {
  return capabilityVerbAllowsRuleWiden(verbName, p.intent, p.metadata);
}

/** A skill's intent and metadata, each read when its row came without it. */
async function readVerbPosture(
  input: GateCapabilityExecutionInput,
  known: Partial<VerbPosture>
): Promise<VerbPosture> {
  if (input.capabilityKind !== "skill") return { intent: null, metadata: null };
  if (known.intent !== undefined && known.metadata !== undefined)
    return { intent: known.intent, metadata: known.metadata };
  const db = await getDb();
  const [row] = await db
    .select({ intent: skills.intent, metadata: skills.metadata })
    .from(skills)
    .where(eq(skills.id, input.capabilityId));
  return {
    intent: known.intent !== undefined ? known.intent : (row?.intent ?? null),
    metadata:
      known.metadata !== undefined ? known.metadata : (row?.metadata ?? null),
  };
}

/**
 * Build the `capability/run` propose decision (the proposal data the executor
 * re-enters on). Shared by every route that asks, so each produces the SAME
 * reviewable proposal shape.
 */
function buildProposeDecision(
  input: GateCapabilityExecutionInput,
  reasonCode: string
): Extract<GateCapabilityDecision, { decision: "propose" }> {
  return {
    decision: "propose",
    reasonCode,
    proposalType: CAPABILITY_RUN_PROPOSAL.proposalType,
    data: {
      capabilityKind: input.capabilityKind,
      capabilityId: input.capabilityId,
      agentUserId: input.agentUserId ?? null,
      workspaceId: input.workspaceId ?? null,
      sessionId: input.sessionId ?? null,
      playbookId: input.playbookId ?? null,
      issuer: input.issuer ?? null,
    },
  };
}
