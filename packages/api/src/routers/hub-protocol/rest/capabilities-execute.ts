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

import { executeCapability } from "../../../services/capabilities/execute-capability.js";

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
      // ONE shared core (also used by the MCP `run_capability` tool).
      const outcome = await executeCapability({
        verbId,
        skillId,
        parameters,
        workspaceId,
        userId,
      });

      switch (outcome.kind) {
        case "not_found":
          return c.json({ error: outcome.message }, 404);
        case "deny":
          return c.json(
            { error: `Capability refused by gate: ${outcome.reason}` },
            403
          );
        case "dry-run":
          return c.json(
            {
              status: "dry-run" as const,
              skillId: outcome.skillId,
              dryRun: true,
            },
            200
          );
        case "proposed":
          return c.json(
            { proposed: true as const, proposalId: outcome.proposalId },
            202
          );
        case "run":
          return c.json(
            {
              status: "run" as const,
              skillId: outcome.skillId,
              result: outcome.result,
            },
            200
          );
      }
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
