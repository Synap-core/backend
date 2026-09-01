/**
 * Capability-execution gate helper — WIRED (approval-state + grant + exec-mode).
 *
 * The single resolution point that turns "an agent wants to RUN this granted
 * capability" into a governance verdict. It composes THREE signals:
 *
 *   (a) the capability's APPROVAL-STATE   → `capabilityGovernance`
 *       (from the tool/skill row's `approved` column)
 *   (b) GRANT EXISTENCE (the model's namesake) — for an agent run that is NOT an
 *       owner run, an ACTIVE `vault_grants` (capability) row must authorize this
 *       redeemer; NO grant → route to `propose` (a human reviews; never auto-run).
 *   (c) the GRANT's exec-mode             → `capabilityExecMode`
 *       (sourced from the grant ROW via `findCapabilityGrant`, NOT request input).
 *
 * It does DB READS (the tool/skill row when not passed in, plus a NON-CONSUMING
 * grant existence check) but performs NO writes — it neither consumes a grant nor
 * flips any status. The use-count is consumed separately at the dispatch point,
 * only when the final verdict is `run` (see external-dispatch.ts), so a run that
 * routes to propose/deny never spends a once-grant.
 *
 * It IS wired into the IS→backend capability-execute chokepoint
 * (`triggerProviderAction` in external-dispatch.ts). It no-ops for the operator
 * door (no `agentUserId`) and for owner runs.
 *
 * Owner bypass: when `actorUserId` owns the capability AND the run is not an agent
 * run (mirrors the vault owner-bypass philosophy — a genuine human owner is never
 * gated on a grant for their OWN capability), the verdict is always `run`.
 *
 * Part of the Playbooks & Capability Substrate (G4 — per-capability governance).
 *
 * HOME: this lives in `@synap/capability-gate` — a thin package depending ONLY on
 * `@synap/database` (grant resolver + tool/skill rows) and `@synap/governance-policy`
 * (the pure decision core). Both `@synap/api` AND `@synap/jobs` import it, so the
 * automation door (jobs) can run the FULL gate instead of an approved-only check.
 * It is NOT in `@synap/governance-policy` because that package is the PURE, I/O-free
 * decision core — adding DB reads there would break that invariant. It is NOT in
 * `@synap/api` because `@synap/jobs` cannot import api (api → jobs already, a cycle).
 */

import { getDb, eq, findCapabilityGrant } from "@synap/database";
import {
  resolveGovernanceRule,
  resolveOriginTrust,
} from "@synap/database/agent-governance";
import { tools, skills } from "@synap/database/schema";
import { decideAgentPolicy } from "@synap/governance-policy";

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
}

export interface GateCapabilityExecutionInput {
  capabilityKind: CapabilityRunKind;
  capabilityId: string;
  /** Pre-loaded tool row (skips the DB read) when kind === "tool". */
  tool?: GateToolRow | null;
  /** Pre-loaded skill row (skips the DB read) when kind === "skill". */
  skill?: GateSkillRow | null;
  /**
   * OPTIONAL legacy exec-mode override carried as JSONB `{ execMode }`. The grant
   * ROW (`findCapabilityGrant`) is the SOURCE OF TRUTH for exec-mode; this field
   * is only an explicit override for callers that already resolved a mode out of
   * band. Absent (the normal case) → exec-mode comes from the grant row.
   */
  grantMetadata?: Record<string, unknown> | null;
  /** The human/agent principal performing the run (for owner-bypass). */
  actorUserId: string;
  /** The agent identity, when the run is agent-initiated. */
  agentUserId?: string | null;
  /**
   * READ-ONLY capability marker — set for a capability whose execution only
   * READS (no mutation). Mirrors execute-provider-verb's `isReadMethod →
   * alreadyApproved:true`: a read is not a mutation, so once it clears the
   * APPROVAL gate it never needs a grant and never proposes — its scope is
   * enforced downstream by the access layer (caller's row floor), NOT by this
   * governance gate. Builtin verbs have no HTTP method, so the caller
   * (executeCapability) sets this explicitly from the read-verb set. Absent
   * (the normal case) → the full grant/propose ladder applies. It NEVER weakens
   * the approval gate above (an unapproved read is still denied).
   */
  readOnly?: boolean;
  workspaceId?: string | null;
  sessionId?: string | null;
  playbookId?: string | null;
  /**
   * The acting channel id, when this run happens in a channel context. Threaded
   * to the #4 instruction-provenance origin-trust resolver (`resolveOriginTrust`):
   * an untrusted-origin channel (EXTERNAL / bridge / `source`) force-proposes the
   * run — it can never auto-run via grant exec-mode, an "auto" capability, OR a
   * governance rule (tighten-only, owner-approved). Set it server-side from the
   * routing/turn seam, never from request-body fields; absent → no channel
   * context → the origin-trust signal no-ops.
   */
  channelId?: string | null;
  /** Free-text issuer label (channel / hub door) for audit; not yet consumed. */
  issuer?: string | null;
  /**
   * Effective per-channel capability grant when the run happens inside a
   * multiplayer channel — passed straight through so rung 2.6's tightening
   * invariant (a channel grant may only narrow an "auto" capability) applies.
   */
  channelCapabilities?: {
    canDraft: boolean;
    canPropose: boolean;
    canAct: boolean;
  } | null;
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
  | { decision: "deny"; reason: string }
  | { decision: "dry-run" };

/**
 * The persistable grant exec-mode (mirrors the `grant_exec_mode` pg enum +
 * `@synap/playbooks ExecMode`). `dry-run` is honored at THIS gate (short-circuit
 * to a preview); `auto`/`propose` flow into the policy. The retired
 * `propose-each`/`block` values are gone — `propose` covers what `propose-each`
 * meant, and deny comes from no-grant / not-approved, not a `block` exec-mode.
 */
type GrantExecMode = "auto" | "propose" | "dry-run";

/**
 * Coerce a loosely-typed grant `execMode` (from the grant ROW, or a legacy
 * metadata override) into the persistable exec-mode union.
 */
function readGrantExecMode(raw: unknown): GrantExecMode | null {
  if (raw === "auto" || raw === "propose" || raw === "dry-run") {
    return raw;
  }
  return null;
}

/**
 * Resolve the governance verdict for executing a granted capability.
 *
 * Resolution order:
 *   1. Owner bypass — a GENUINE human owner run (`actorUserId` owns the
 *      capability AND no `agentUserId`) → `run`. An agent under the owner's
 *      identity is NOT owner-bypassed — it is grant-gated like any agent.
 *   2. GRANT EXISTENCE + exec-mode (the model's namesake) — for an agent run
 *      (`agentUserId` present) that is not an owner run, look up an ACTIVE
 *      capability grant for this redeemer (NON-CONSUMING). NO grant → consult a
 *      stored `governance_rules` capability rule (see `capabilityRuleAuthorizesRun`
 *      below); an ACTIVE `verdict:"auto"` rule authorizes the run WITH NO GRANT
 *      (Option B, D1 — GOVERNANCE-PHASE2-PLAN.md §1). No rule either → `propose`
 *      (a human reviews; an ungranted, unruled capability must never auto-run).
 *      A grant → its `execMode` is the source of truth (`auto | propose |
 *      dry-run`); `dry-run` short-circuits to a preview before the policy call
 *      — a rule can NEVER override dry-run, it is checked strictly after.
 *   3. Approval-state — an UNAPPROVED capability is never auto-runnable for a
 *      non-owner → `capabilityGovernance = "propose"`; approved → "auto". This
 *      floor is absolute: `approved === false` denies above (step 0) BEFORE any
 *      grant/rule consultation, so a rule can never resurrect a disabled capability.
 *   4. `decideAgentPolicy` rung 2.6 maps the two signals to execute/propose/deny.
 *      A `propose` verdict here ALSO consults the capability rule (same helper)
 *      before falling through to a reviewable proposal.
 *
 * Reads the one tool/skill row (when not pre-loaded) + a non-consuming grant
 * existence check + (only on the propose path) one `governance_rules` lookup.
 * NO writes (use-count is consumed at the dispatch point only when the verdict
 * is `run`).
 *
 * KNOWN LIMITATION, NARROWED (2026-07-27): a capability rule MAY still be
 * keyed on the row `capabilityId`, and skills/tools are RE-CREATED with a new
 * id on reinstall (`execute-capability.ts:124-129`) — a rule authored against
 * the old id alone would silently stop matching after a reinstall, the same
 * staleness class `vault_grants` already has. Rules are now ALSO matchable by
 * the capability's stable VERB NAME (`tools.name`/`skills.name`, = `verbId` —
 * `scoreRuleTarget`'s `targetKind: "capability"` branch matches either), which
 * survives a reinstall — the UI should author "always approve this
 * capability" rules against the verb name, not the id, to be reinstall-safe.
 */
export async function gateCapabilityExecution(
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
        })
        .from(skills)
        .where(eq(skills.id, input.capabilityId));
      row = loaded ?? null;
    }
    approved = row?.approved ?? null;
    ownerId = row?.userId ?? null;
    verbName = row?.name ?? null;
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
  if (approved === false) {
    return {
      decision: "deny",
      // NOTE: a `capability.enable` proposal type + approve-executor exist
      // (routers/proposals/approve-executors.ts) so an agent can PROPOSE
      // enabling instead of only relaying this text — its creation call site
      // (from this deny path) is deliberately deferred; wire it there.
      reason:
        "This capability is installed but not yet enabled. Ask the user to enable it (Settings → Capabilities), or run with dryRun to preview.",
    };
  }

  // ── READ-ONLY short-circuit — mirrors execute-provider-verb's
  //    `isReadMethod → alreadyApproved:true`. A read is not a mutation: once it
  //    clears the APPROVAL gate above, it never needs a grant and never proposes.
  //    Its SCOPE is enforced downstream by the access layer (the caller's row
  //    floor), not by this governance gate — so a read can never leak
  //    cross-workspace rows here, and can never spawn a proposal. Applies to
  //    EVERY caller (operator AND agent), which is why it precedes owner-bypass
  //    and the grant-existence check. WRITES leave `readOnly` unset and fall
  //    through to the full ladder below.
  if (input.readOnly) {
    return { decision: "run" };
  }

  // ── 1. Owner bypass — only a GENUINE human owner run (no agentUserId) skips the
  //       grant. An agent acting under the owner's identity is grant-gated.
  const isOwnerRun =
    !input.agentUserId &&
    !!ownerId &&
    !!input.actorUserId &&
    ownerId === input.actorUserId;
  if (isOwnerRun) {
    return { decision: "run" };
  }

  // ── 1.5 ORIGIN TRUST (#4 instruction-provenance) — resolve ONCE for this
  //       agent run. An untrusted-origin channel (EXTERNAL / bridge / `source`)
  //       force-proposes the run: it can NEVER auto-run via grant exec-mode, an
  //       "auto" capability, or a governance rule. Owner/read-only runs already
  //       returned above and are unaffected. Only agent runs are classified;
  //       absent channelId → no channel read → undefined (no downgrade).
  const originTrust = input.agentUserId
    ? await resolveOriginTrust({
        db: await getDb(),
        channelId: input.channelId,
        userId: input.actorUserId,
        workspaceId: input.workspaceId ?? null,
        capabilityId: input.capabilityId,
      })
    : undefined;
  const originUntrusted = originTrust === "untrusted";

  // ── 2. GRANT EXISTENCE + exec-mode (the model's namesake) ───────────────────
  // For an agent run that is NOT an owner run, an ACTIVE capability grant must
  // authorize this redeemer. NO grant → propose (a human reviews; an ungranted
  // capability must NEVER auto-run). When a grant exists, its `execMode` is the
  // SOURCE OF TRUTH for how the run is governed (auto | propose | dry-run).
  // The lookup is NON-CONSUMING — the use is spent at the dispatch point only on
  // a `run` verdict (so a propose/deny outcome never burns a once-grant).
  let grantExecMode = readGrantExecMode(input.grantMetadata); // legacy override
  if (input.agentUserId) {
    // tool | skill | command are all grantable (findCapabilityGrant excludes only
    // `secret`). An agent run of any of them requires an active grant.
    const grant = await findCapabilityGrant(
      input.capabilityKind,
      input.capabilityId,
      {
        agentUserId: input.agentUserId,
        workspaceId: input.workspaceId ?? null,
      }
    );
    if (!grant.ok) {
      // No active grant for this agent → consult a stored capability rule
      // before proposing (Option B, D1: a rule can authorize a run with NO
      // grant at all). No matching "auto" rule → route to a reviewable
      // proposal (a human can approve the run); do NOT hard-deny.
      // #4: an untrusted origin can NEVER be widened to run by a rule (rung
      // 2.55 sits above rung 2.8) — skip the rule shortcut and propose.
      if (
        !originUntrusted &&
        (await capabilityRuleAuthorizesRun(input, verbName))
      ) {
        return { decision: "run" };
      }
      // The policy has NOT run on this path — it short-circuits above the
      // verdict — so the rung-2.55 floor has to be named here or it is lost.
      return buildProposeDecision(
        input,
        originUntrusted ? "UNTRUSTED_ORIGIN" : "CAPABILITY_PROPOSE"
      );
    }
    // Grant row is the source of truth for exec-mode (override only if explicitly
    // supplied via grantMetadata — normally absent).
    grantExecMode = grantExecMode ?? readGrantExecMode(grant.execMode);
  }

  // "dry-run" is a grant-level preview switch with no policy rung — honor it
  // before the verdict (the chokepoint stubs the actual external write).
  if (grantExecMode === "dry-run") {
    return { decision: "dry-run" };
  }

  // ── 3. derive the approval-state signal ─────────────────────────────────────
  const capabilityGovernance: "auto" | "propose" = approved
    ? "auto"
    : "propose";

  // ── 4. delegate to the pure decision core (rung 2.6) ────────────────────────
  // `dry-run` already short-circuited above, so only auto|propose reach the policy.
  const policyExecMode: "auto" | "propose" | null =
    grantExecMode === "auto" || grantExecMode === "propose"
      ? grantExecMode
      : null;
  const verdict = decideAgentPolicy({
    subjectType: CAPABILITY_RUN_PROPOSAL.targetType,
    action: CAPABILITY_RUN_PROPOSAL.proposalType,
    capabilityGovernance,
    capabilityExecMode: policyExecMode,
    channelCapabilities: input.channelCapabilities ?? undefined,
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
  // propose — consult a stored capability rule (Option B) before falling
  // through to a reviewable `capability/run` proposal. #4: an untrusted origin
  // can NEVER be widened to run by a rule (rung 2.55 sits above rung 2.8).
  if (
    !originUntrusted &&
    (await capabilityRuleAuthorizesRun(input, verbName))
  ) {
    return { decision: "run" };
  }
  // The verdict already carries the structured cause (the policy emits
  // UNTRUSTED_ORIGIN / ADMIN / DESTRUCTIVE_HARD_FLOOR itself). It was being
  // dropped on the floor here; carry it through rather than re-deriving it.
  return buildProposeDecision(
    input,
    verdict.reasonCode ?? "CAPABILITY_PROPOSE"
  );
}

/**
 * Consult a stored `governance_rules` `target_kind: "capability"` row for
 * this `(agentUserId, workspaceId, capabilityId)` — Option B / D1 (ratified
 * 2026-07-27, GOVERNANCE-PHASE2-PLAN.md §1). An ACTIVE `verdict: "auto"` row
 * widens an otherwise-`propose` capability run to `run`.
 *
 * Scoped to grantable kinds ONLY: `input.capabilityKind` is typed
 * `CapabilityRunKind` ("tool" | "skill" | "command"), which never includes
 * `"secret"` — so this can never be reached for, and can never authorize, a
 * secret decrypt. Callers must NEVER call this for the `approved === false`
 * deny floor or the `dry-run` short-circuit — both are checked strictly
 * BEFORE either call site that invokes this helper (see the resolution-order
 * doc above), so a rule can never cross those floors.
 *
 * `verbName` (the capability's stable `tools.name`/`skills.name`) is passed
 * through to `resolveGovernanceRule` alongside `capabilityId` so a rule
 * authored against the VERB NAME (reinstall-stable) matches equally to one
 * authored against the row id (reinstall-unstable, the KNOWN LIMITATION
 * above) — see `scoreRuleTarget`'s `targetKind: "capability"` branch.
 */
async function capabilityRuleAuthorizesRun(
  input: GateCapabilityExecutionInput,
  verbName: string | null
): Promise<boolean> {
  if (!input.agentUserId) return false;
  // Defence-in-depth: `input.capabilityKind` is typed `CapabilityRunKind`
  // ("tool" | "skill" | "command"), which structurally excludes "secret" —
  // this runtime guard holds even against a future type widening or an
  // `as` cast, so a rule can never be consulted for a secret grantable.
  if ((input.capabilityKind as string) === "secret") return false;
  const db = await getDb();
  const match = await resolveGovernanceRule({
    db,
    agentUserId: input.agentUserId,
    workspaceId: input.workspaceId ?? null,
    subjectType: CAPABILITY_RUN_PROPOSAL.targetType,
    action: CAPABILITY_RUN_PROPOSAL.proposalType,
    capabilityId: input.capabilityId,
    capabilityVerbName: verbName,
  });
  return match?.verdict === "auto";
}

/**
 * Build the `capability/run` propose decision (the proposal data the executor
 * re-enters on). Shared by the no-grant route and the policy `propose` verdict so
 * an ungranted agent run and a propose-mode grant produce the SAME reviewable
 * proposal shape.
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
