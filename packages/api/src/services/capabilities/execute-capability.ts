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

import { db, skills, eq, and, or, isNull } from "@synap/database";

import { gateCapabilityExecution } from "./gate-capability-execution.js";
import { executeSkillViaIS } from "../skills/execute-skill-via-is.js";
import { executeProviderVerb } from "./execute-provider-verb.js";
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
  /** Runtime 1-of-N connection selector (Wave 4) — passed to a provider verb. */
  connectionSelector?: ConnectionSelector | null;
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
    .limit(1);

  if (!skillRow) {
    return {
      kind: "not_found",
      message: `Capability ${
        skillId ? `skill "${skillId}"` : `verb "${verbId}"`
      } not found in this workspace.`,
    };
  }

  const decision = await gateCapabilityExecution({
    capabilityKind: "skill",
    capabilityId: skillRow.id,
    skill: skillRow,
    actorUserId: userId,
    agentUserId: null,
    workspaceId,
    issuer: "hub.capabilities-execute",
  });

  if (decision.decision === "deny") {
    return { kind: "deny", reason: decision.reason };
  }
  if (decision.decision === "dry-run") {
    return { kind: "dry-run", skillId: skillRow.id };
  }
  if (decision.decision === "propose") {
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
      },
      notificationDescription: `Run capability ${verbId ?? skillRow.id}`,
    });
    return { kind: "proposed", proposalId: proposal.id };
  }

  // decision === "run" → execute the backing skill.
  //
  // TIER 1 (provider verb): a `kind:'provider'` skill is a DECLARATIVE spec the
  // pod runs IN-PROCESS via triggerProviderAction — no IS, no isolate. The
  // skill-level gate above already ran; the engine passes `alreadyApproved:true`
  // so the tool gate does not double-propose.
  if (skillRow.kind === "provider" && skillRow.providerSpec) {
    const result = await executeProviderVerb(
      skillRow.providerSpec,
      parameters,
      {
        userId,
        workspaceId: workspaceId ?? undefined,
        connectionSelector: input.connectionSelector ?? null,
      }
    );
    return { kind: "run", skillId: skillRow.id, result };
  }

  // TIER 2 (code/instruction): execute the backing skill in the IS sandbox.
  const result = await executeSkillViaIS({
    skillId: skillRow.id,
    userId,
    parameters,
  });
  return { kind: "run", skillId: skillRow.id, result };
}
