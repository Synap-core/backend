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
}
export interface GateSkillRow {
  id: string;
  approved: boolean | null;
  /** Owner principal — `skills.user_id`. */
  userId: string | null;
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
  workspaceId?: string | null;
  sessionId?: string | null;
  playbookId?: string | null;
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
 *      capability grant for this redeemer (NON-CONSUMING). NO grant → `propose`
 *      (a human reviews; an ungranted capability must never auto-run). A grant →
 *      its `execMode` is the source of truth (`auto | propose | dry-run`);
 *      `dry-run` short-circuits to a preview before the policy call.
 *   3. Approval-state — an UNAPPROVED capability is never auto-runnable for a
 *      non-owner → `capabilityGovernance = "propose"`; approved → "auto".
 *   4. `decideAgentPolicy` rung 2.6 maps the two signals to execute/propose/deny.
 *
 * Reads the one tool/skill row (when not pre-loaded) + a non-consuming grant
 * existence check. NO writes (use-count is consumed at the dispatch point only
 * when the verdict is `run`).
 */
export async function gateCapabilityExecution(
  input: GateCapabilityExecutionInput
): Promise<GateCapabilityDecision> {
  // ── (a) load approval-state + owner ─────────────────────────────────────────
  let approved: boolean | null = null;
  let ownerId: string | null = null;

  if (input.capabilityKind === "tool") {
    let row = input.tool ?? null;
    if (!row) {
      const db = await getDb();
      const [loaded] = await db
        .select({
          id: tools.id,
          approved: tools.approved,
          createdBy: tools.createdBy,
        })
        .from(tools)
        .where(eq(tools.id, input.capabilityId));
      row = loaded ?? null;
    }
    approved = row?.approved ?? null;
    ownerId = row?.createdBy ?? null;
  } else if (input.capabilityKind === "skill") {
    let row = input.skill ?? null;
    if (!row) {
      const db = await getDb();
      const [loaded] = await db
        .select({
          id: skills.id,
          approved: skills.approved,
          userId: skills.userId,
        })
        .from(skills)
        .where(eq(skills.id, input.capabilityId));
      row = loaded ?? null;
    }
    approved = row?.approved ?? null;
    ownerId = row?.userId ?? null;
  } else {
    // commands have no approved/owner column today → conservative defaults.
    approved = null;
    ownerId = null;
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
      // No active grant for this agent → must NOT auto-run. Route to a reviewable
      // proposal (a human can approve the run); do NOT hard-deny.
      return buildProposeDecision(input);
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
  });

  if (verdict.verdict === "execute") {
    return { decision: "run" };
  }
  if (verdict.verdict === "deny") {
    return { decision: "deny", reason: verdict.reason };
  }
  // propose — build the `capability/run` proposal data the executor re-enters on.
  return buildProposeDecision(input);
}

/**
 * Build the `capability/run` propose decision (the proposal data the executor
 * re-enters on). Shared by the no-grant route and the policy `propose` verdict so
 * an ungranted agent run and a propose-mode grant produce the SAME reviewable
 * proposal shape.
 */
function buildProposeDecision(
  input: GateCapabilityExecutionInput
): Extract<GateCapabilityDecision, { decision: "propose" }> {
  return {
    decision: "propose",
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
