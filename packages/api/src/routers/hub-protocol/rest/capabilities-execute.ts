/**
 * Hub Protocol REST — POST /capabilities/execute
 *
 * The AGNOSTIC capability-execution door — the seam that completes the capability
 * substrate. Registration was already pure config (POST /tools,
 * /agent-skills/executable, POST /capabilities/apply); this is the missing door
 * that LAUNCHES a registered capability on demand from an external caller,
 * governed by the SAME `gateCapabilityExecution` every other capability path
 * uses. No per-integration endpoint ever again: any {tool + skill} applied as
 * config becomes runnable here.
 *
 * A capability VERB is backed by a SKILL — its `verbId` is the requiring skill's
 * NAME (see schema/tools.ts ToolVerbCatalogEntry.id, and the automation worker's
 * `case "capability"`). So this door resolves verb→skill (or takes a `skillId`
 * directly), runs the gate, and on `run` delegates to the IS sandbox executor via
 * the shared `executeSkillViaIS` (ONE wire contract, also used by the
 * `capability.run` approve-executor). Mirrors the worker exactly: one decision
 * core, multiple doors.
 *
 * Identity scope: this REST door runs as the OPERATOR/owner (the bearer's user).
 * Agent-initiated capability runs flow through the IS agent loop + the automation
 * worker, NOT this door — so no `agentUserId` is accepted here, which keeps the
 * gate's owner-bypass clean (the bearer who applied the capability owns the skill
 * → runs directly; a non-owner/unapproved skill routes to `propose`).
 */

import { z } from "@hono/zod-openapi";
import { db, skills, eq, and, or, isNull } from "@synap/database";

import { gateCapabilityExecution } from "../../../services/capabilities/gate-capability-execution.js";
import { executeSkillViaIS } from "../../../services/skills/execute-skill-via-is.js";
import { createPendingProposal } from "../../../utils/permission-check.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const ExecuteCapabilityRequestSchema = z
  .object({
    /** The capability verb to run — the backing skill's NAME. One of verbId/skillId required. */
    verbId: z.string().min(1).optional(),
    /** Direct skill id (alternative to verbId). */
    skillId: z.string().min(1).optional(),
    /** Inputs passed to the skill (the sandbox `args`). */
    parameters: z.record(z.string(), z.unknown()).optional(),
    /** Acting workspace — scopes the skill lookup + the gate, and routes a `propose` proposal. */
    workspaceId: z.string().uuid(),
  })
  .refine((b) => !!b.verbId || !!b.skillId, {
    message: "Either verbId or skillId is required",
  })
  .openapi("ExecuteCapabilityRequest");

const ExecuteCapabilityResultSchema = z
  .object({
    status: z.enum(["run", "dry-run"]),
    skillId: z.string(),
    result: z.unknown().optional(),
    dryRun: z.boolean().optional(),
  })
  .openapi("ExecuteCapabilityResult");

const ExecuteCapabilityProposedSchema = z
  .object({
    proposed: z.literal(true),
    proposalId: z.string(),
  })
  .openapi("ExecuteCapabilityProposed");

export function registerCapabilitiesExecuteRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/capabilities/execute",
    tags: ["Capabilities"],
    summary: "Execute a registered capability (agnostic capability launcher)",
    description:
      "Resolves a capability verb (verbId = backing skill name) or a skillId to " +
      "its skill, runs it through gateCapabilityExecution, and on `run` delegates " +
      "to the IS sandbox executor. Returns 200 with the result (or a dry-run " +
      "preview), 202 with a reviewable proposal when governance requires approval, " +
      "403 when denied. Requires hub-protocol.write scope.",
    request: { body: ExecuteCapabilityRequestSchema },
    responses: {
      200: {
        description: "Execution result",
        schema: ExecuteCapabilityResultSchema,
      },
      202: {
        description:
          "Execution requires human approval — a reviewable proposal was created instead of running.",
        schema: ExecuteCapabilityProposedSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden / denied by gate", schema: ErrorSchema },
      404: { description: "Capability/skill not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/capabilities/execute", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    let body: z.infer<typeof ExecuteCapabilityRequestSchema>;
    try {
      body = ExecuteCapabilityRequestSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid request body" },
        400
      );
    }

    const { verbId, skillId, parameters, workspaceId } = body;

    const acting = await resolveActingContext(c, { workspaceId });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;

    try {
      // Resolve the backing skill — by id, or by verb NAME scoped exactly like the
      // capability registry read-model + the worker's `case "capability"`:
      // pod-wide (NULL workspace) OR this workspace OR owned by the actor.
      const [skillRow] = await db
        .select({
          id: skills.id,
          approved: skills.approved,
          userId: skills.userId,
        })
        .from(skills)
        .where(
          skillId
            ? eq(skills.id, skillId)
            : and(
                eq(skills.name, verbId!),
                or(
                  isNull(skills.workspaceId),
                  eq(skills.workspaceId, workspaceId),
                  eq(skills.userId, userId)
                )
              )
        )
        .limit(1);

      if (!skillRow) {
        return c.json(
          {
            error: `Capability ${
              skillId ? `skill "${skillId}"` : `verb "${verbId}"`
            } not found in this workspace.`,
          },
          404
        );
      }

      // SAME gate as the worker + IS doors. Operator/owner run (no agent identity):
      //   owner-bypass (bearer owns the skill) → run; non-owner unapproved → propose.
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
        return c.json(
          { error: `Capability refused by gate: ${decision.reason}` },
          403
        );
      }

      if (decision.decision === "dry-run") {
        return c.json(
          { status: "dry-run" as const, skillId: skillRow.id, dryRun: true },
          200
        );
      }

      if (decision.decision === "propose") {
        // Route to a reviewable proposal that, on approval, re-enters the SAME
        // executeSkillViaIS path via the `capability.run` approve-executor.
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
        return c.json(
          { proposed: true as const, proposalId: proposal.id },
          202
        );
      }

      // decision === "run" → execute the backing skill in the IS sandbox.
      const result = await executeSkillViaIS({
        skillId: skillRow.id,
        userId,
        parameters,
      });
      return c.json(
        { status: "run" as const, skillId: skillRow.id, result },
        200
      );
    } catch (err) {
      logger.error(
        { err, verbId, skillId },
        "POST /capabilities/execute failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
