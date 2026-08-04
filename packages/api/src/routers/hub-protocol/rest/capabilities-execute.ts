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
 * Identity scope: a genuine OPERATOR run (Kratos cookie / operator key, no
 * agentUserId) owns the applied skill → owner-bypass runs it directly. An AGENT
 * run (agent key sets `agentUserId`) threads that identity into the gate: a
 * read-only verb still auto-runs, but an agent WRITE verb without an active grant
 * routes to `propose` — so an agent can't launder itself into an ungoverned
 * operator write ("AI mutations → checkPermissionOrPropose" holds here too).
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
    /** Acting workspace — OPTIONAL lens that narrows the skill lookup + the gate.
     * Omit for a pod-wide run; a `propose` then routes to the user's pod-wide queue. */
    workspaceId: z.string().uuid().optional(),
    /** Runtime 1-of-N connection selector (Wave 4) — pick which of the capability's
     * connections this run uses. `connectionId` = a specific connection; `contextObjectId`
     * = the connection bound to that context object. A selector matching nothing fails the run. */
    connectionSelector: z
      .object({
        connectionId: z.string().optional(),
        contextObjectId: z.string().optional(),
      })
      .optional(),
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
    /** Observability handle for a direct run — pass to diagnose / getRun. */
    correlationId: z.string().optional(),
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
      424: {
        description:
          "Failed dependency — a client-actionable connection failure (auth expired/absent, or a missing target). Body carries errorClass + providerRef so the caller can offer a reconnect path.",
        schema: ErrorSchema,
      },
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

    const { verbId, skillId, parameters, workspaceId, connectionSelector } =
      body;

    const acting = await resolveActingContext(c, { workspaceId });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;

    try {
      // ONE shared core (also used by the MCP `run_capability` tool).
      const outcome = await executeCapability({
        verbId,
        skillId,
        parameters,
        workspaceId: acting.workspaceId,
        userId,
        // Thread the acting agent (agent-key runs set this) so an agent WRITE
        // verb is governed by grant/propose instead of laundering into an
        // ungoverned operator run. A genuine operator (Kratos cookie) has none.
        agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
        connectionSelector,
      });

      switch (outcome.kind) {
        case "not_found":
          return c.json({ error: outcome.message }, 404);
        case "deny":
          return c.json(
            { error: `Capability refused by gate: ${outcome.reason}` },
            403
          );
        case "error": {
          // The verb RAN and its handler FAILED (code sandbox / provider error).
          // A CONNECTION-class failure (expired/absent auth, a gone target) is
          // CLIENT-ACTIONABLE, not a server fault: surface it as 4xx so
          //   (a) it reads as "you can fix this" (reconnect), not "the server
          //       crashed", and
          //   (b) `errorClass` + `providerRef` SURVIVE the 5xx egress sanitizer
          //       (middleware/error-egress.ts redacts every 5xx body; 4xx is left
          //       intact) — the CLI / MCP agent reads them to offer a reconnect
          //       path. This is the same self-heal signal the browser P1 chip uses.
          // A genuine provider/transient/server fault stays 500 (correctly
          // sanitized — its raw message may carry a driver stack).
          const ec = outcome.errorClass;
          const isReconnect =
            ec === "auth" || ec === "no_connection" || ec === "target_missing";
          if (isReconnect) {
            return c.json(
              {
                error: outcome.message,
                code:
                  ec === "target_missing"
                    ? "TARGET_MISSING"
                    : "CONNECTION_REAUTH",
                errorClass: ec,
                providerRef: outcome.providerRef,
              },
              424
            );
          }
          return c.json(
            { error: `Capability execution failed: ${outcome.message}` },
            500
          );
        }
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
            {
              proposed: true as const,
              proposalId: outcome.proposalId,
              reviewUrl: outcome.reviewUrl,
            },
            202
          );
        case "run":
          return c.json(
            {
              status: "run" as const,
              skillId: outcome.skillId,
              result: outcome.result,
              // The direct-run observability handle (best-effort — see
              // executeCapability): lets the caller diagnose/getRun the run.
              correlationId: outcome.correlationId,
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
