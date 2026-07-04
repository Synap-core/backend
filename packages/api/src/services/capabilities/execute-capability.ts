/**
 * Capability execution — ONE shared core for "launch a registered capability".
 *
 * Resolves a capability VERB (verbId = backing skill name) or a skillId to its
 * skill, runs `gateCapabilityExecution`, and on `run` delegates to the IS sandbox
 * via `executeSkillViaIS`. Returns a discriminated result the callers map to their
 * own shape:
 *   - Hub REST `POST /capabilities/execute` → HTTP 200/202/403/404
 *   - MCP tool `run_capability` → a text result
 *
 * Identity: OPERATOR/owner run (no agentUserId) — the bearer who applied the
 * capability owns the skill → owner-bypass runs it; a non-owner/unapproved skill
 * routes to `propose`. (Agent-initiated runs flow through the IS agent loop, not
 * this door.) A DRAFT skill is denied for everyone (approval gate) — enable it
 * first via `POST /skills/:id/approve`.
 */

import { db, skills, eq, and, or, isNull, desc } from "@synap/database";

import { gateCapabilityExecution } from "./gate-capability-execution.js";
import { executeSkillViaIS } from "../skills/execute-skill-via-is.js";
import { executeProviderVerb } from "./execute-provider-verb.js";
import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";
import type { ConnectionSelector } from "../../connectors/external-dispatch.js";
import { createPendingProposal } from "../../utils/permission-check.js";

export type ExecuteCapabilityResult =
  | { kind: "run"; skillId: string; result: unknown }
  | { kind: "dry-run"; skillId: string }
  | { kind: "proposed"; proposalId: string }
  | { kind: "deny"; reason: string }
  | { kind: "not_found"; message: string };

export async function executeCapability(input: {
  /** Capability verb = backing skill NAME. One of verbId/skillId required. */
  verbId?: string;
  /** Direct skill id (alternative to verbId). */
  skillId?: string;
  /** Inputs passed to the skill sandbox (`args`). */
  parameters?: Record<string, unknown>;
  /** Acting workspace — OPTIONAL lens that narrows the skill lookup + the gate.
   * `null` = pod-wide run; a `propose` then routes to the user's pod-wide queue. */
  workspaceId: string | null;
  /** The acting operator (bearer's user). */
  userId: string;
  /**
   * The acting AGENT (agent-user id) when the call originates from an agent — the
   * MCP `run_capability` tool or a Hub agent key — else null for a genuine
   * operator run. Threaded to the gate: an agent WRITE verb without an active
   * grant routes to a PROPOSAL (never auto-runs under the operator's identity);
   * READ-only verbs auto-run regardless (the readOnly short-circuit precedes the
   * grant check). This is what makes "AI mutations → checkPermissionOrPropose"
   * hold at this door instead of laundering the agent into the operator.
   */
  agentUserId?: string | null;
  /** Runtime 1-of-N connection selector (Wave 4) — passed to a provider verb. */
  connectionSelector?: ConnectionSelector | null;
  /**
   * Callers with NO interactive review surface (e.g. the automation executor)
   * set this so a `propose` verdict returns a plain `deny` INSTEAD of persisting
   * a proposal row — otherwise a recurring automation with an unapproved verb
   * would spawn a duplicate proposal every tick. Approve the skill to run it
   * unattended.
   */
  suppressProposal?: boolean;
}): Promise<ExecuteCapabilityResult> {
  const { verbId, skillId, parameters, workspaceId, userId } = input;
  if (!verbId && !skillId) {
    return {
      kind: "not_found",
      message: "Either verbId or skillId is required",
    };
  }

  // Resolve the backing skill — by id, or by verb NAME scoped exactly like the
  // capability registry read-model: pod-wide OR this workspace OR owned by actor.
  const [skillRow] = await db
    .select({
      id: skills.id,
      name: skills.name,
      approved: skills.approved,
      userId: skills.userId,
      kind: skills.kind,
      providerSpec: skills.providerSpec,
    })
    .from(skills)
    .where(
      skillId
        ? eq(skills.id, skillId)
        : and(
            eq(skills.name, verbId!),
            or(
              isNull(skills.workspaceId),
              ...(workspaceId ? [eq(skills.workspaceId, workspaceId)] : []),
              eq(skills.userId, userId)
            )
          )
    )
    // Deterministic resolution when a verb NAME has duplicates (e.g. a stale
    // re-installed capability): prefer an approved skill, then the most recently
    // updated — so a fresh re-apply wins over a stale shadow instead of a random
    // `.limit(1)`. (The real fix for duplicates is de-dup; this hardens the door.)
    .orderBy(desc(skills.approved), desc(skills.updatedAt))
    .limit(1);

  if (!skillRow) {
    return {
      kind: "not_found",
      message: `Capability ${
        skillId ? `skill "${skillId}"` : `verb "${verbId}"`
      } not found in this workspace.`,
    };
  }

  // A read-only BUILTIN verb is not a mutation — mark the gate `readOnly` so it
  // auto-runs (no grant, no propose) once it clears the approval gate; its scope
  // is enforced by the access layer inside the handler, NOT by the gate. Mirrors
  // execute-provider-verb's `isReadMethod → alreadyApproved:true`. WRITE builtins
  // (and every non-builtin) leave this false and flow through the full ladder.
  const readOnly =
    skillRow.kind === "builtin" && READ_ONLY_BUILTIN_VERBS.has(skillRow.name);

  const decision = await gateCapabilityExecution({
    capabilityKind: "skill",
    capabilityId: skillRow.id,
    skill: skillRow,
    actorUserId: userId,
    agentUserId: input.agentUserId ?? null,
    workspaceId,
    issuer: "hub.capabilities-execute",
    readOnly,
  });

  if (decision.decision === "deny") {
    return { kind: "deny", reason: decision.reason };
  }
  if (decision.decision === "dry-run") {
    return { kind: "dry-run", skillId: skillRow.id };
  }
  if (decision.decision === "propose") {
    if (input.suppressProposal) {
      return {
        kind: "deny",
        reason:
          "Capability requires approval and no review surface is available (unattended run); approve the skill to run it.",
      };
    }
    const proposal = await createPendingProposal({
      userId,
      workspaceId,
      targetType: "capability",
      targetId: skillRow.id,
      proposalType: "capability.run",
      data: {
        skillId: skillRow.id,
        verbId: verbId ?? null,
        parameters: parameters ?? {},
        workspaceId,
        // Carry the 1-of-N connection selector so an APPROVED run resolves the
        // same connection the original call intended (see runResolvedSkill).
        connectionSelector: input.connectionSelector ?? null,
      },
      notificationDescription: `Run capability ${verbId ?? skillRow.id}`,
    });
    return { kind: "proposed", proposalId: proposal.id };
  }

  // decision === "run" → execute through the SINGLE post-gate runner (shared with
  // the capability.run proposal replay), so the door and an approved proposal can
  // never diverge on kind-routing.
  return runResolvedSkill(skillRow, parameters, {
    userId,
    workspaceId,
    connectionSelector: input.connectionSelector ?? null,
  });
}

/** The gate-approved skill row shape `runResolvedSkill` operates on. */
export interface ResolvedSkillRow {
  id: string;
  name: string;
  kind: string | null;
  providerSpec: Parameters<typeof executeProviderVerb>[0] | null;
}

/**
 * The SINGLE post-gate execution branch: given a gate-approved skill row, run it
 * by kind. Called by BOTH executeCapability (the door) AND the `capability.run`
 * proposal replay (proposals/approve-executors), so an approved proposal can
 * never diverge from the door's routing — the kind-branch has exactly one home.
 *   TIER 0 builtin      → governed in-process handler (BUILTIN_VERBS)
 *   TIER 1 declarative  → executeProviderVerb (connection-aware, in-process)
 *   TIER 2 code/instr.  → the IS isolate
 */
export async function runResolvedSkill(
  skill: ResolvedSkillRow,
  parameters: Record<string, unknown> | undefined,
  ctx: {
    userId: string;
    workspaceId: string | null;
    connectionSelector?: ConnectionSelector | null;
  }
): Promise<
  | { kind: "run"; skillId: string; result: unknown }
  | { kind: "not_found"; message: string }
  | { kind: "deny"; reason: string }
> {
  if (skill.kind === "builtin") {
    const handler = BUILTIN_VERBS[skill.name];
    if (!handler) {
      return {
        kind: "not_found",
        message: `No builtin handler registered for verb "${skill.name}".`,
      };
    }
    const result = await handler(parameters ?? {}, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return { kind: "run", skillId: skill.id, result };
  }

  if (skill.kind === "declarative") {
    // A declarative verb with no providerSpec is malformed — fail explicitly
    // rather than falling through to the IS isolate (which has no code to run).
    if (!skill.providerSpec) {
      return {
        kind: "not_found",
        message: `Declarative verb "${skill.name}" is missing its providerSpec.`,
      };
    }
    const result = await executeProviderVerb(skill.providerSpec, parameters, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId ?? undefined,
      connectionSelector: ctx.connectionSelector ?? null,
    });
    return { kind: "run", skillId: skill.id, result };
  }

  // A run-time connection pick can't reach the IS sandbox (`executeSkillViaIS`
  // takes no selector). Rather than SILENTLY running against the capability's
  // default credential — the wrong account, with no signal — refuse explicitly.
  // Declarative/provider verbs (above) honor the selector; for a code-backed
  // verb the user should set the capability's default connection instead.
  if (
    ctx.connectionSelector?.connectionId ||
    ctx.connectionSelector?.contextObjectId
  ) {
    return {
      kind: "deny",
      reason: `Verb "${skill.name}" runs as a code skill and does not support run-time connection selection. Set the capability's default connection instead.`,
    };
  }

  // TIER 2 (code/instruction): execute the backing skill in the IS sandbox.
  const result = await executeSkillViaIS({
    skillId: skill.id,
    userId: ctx.userId,
    parameters,
  });
  return { kind: "run", skillId: skill.id, result };
}
