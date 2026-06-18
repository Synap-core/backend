/**
 * Hub Protocol REST — playbook runs (capture-back)
 *
 * The BYOA / IS capture-back surface for the executor spine (Phase 3). An
 * external agent (or the IS) reports a run's outcome back into Synap:
 *
 *   POST /runs/:runId/capture  — update a run's status/summary and record the
 *                                entities it produced (`session → produced → entity`).
 *
 * Requires hub-protocol.write scope. The acting principal's workspace MUST match
 * the run's workspace (cross-tenant guard). Writes go through
 * `checkPermissionOrPropose` so the governance membrane is honored — on
 * "proposed" the run is NOT mutated (the proposal is the record).
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.4,
 * external-agent capture-back; BYOA acts only through the Hub Protocol).
 */

import { z } from "zod";
import { db, eq, inArray, playbookRuns } from "@synap/database";
import { entities } from "@synap/database/schema";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { createLinks } from "../../../services/links/links-service.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

// ── Wire schemas ─────────────────────────────────────────────────────────────

const CaptureRequestSchema = z.object({
  summary: z.string().max(10_000).optional(),
  status: z.enum(["running", "completed", "failed", "proposed"]).optional(),
  error: z.string().max(10_000).optional(),
  producedEntityIds: z.array(z.string()).optional(),
  /** Capabilities the run actually invoked → `session → used → {tool|skill|command}` provenance. */
  usedCapabilities: z
    .array(
      z.object({ kind: z.enum(["tool", "skill", "command"]), id: z.string() })
    )
    .optional(),
  agentUserId: z.string().optional(),
});

const CaptureResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  proposalId: z.string().nullable(),
});

export function registerRunsRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/runs/{runId}/capture",
    tags: ["Playbooks"],
    summary: "Capture a playbook run's outcome",
    description:
      "Reports a run's status/summary back into Synap and records the entities it produced (session → produced → entity links). Governance-gated; on 'proposed' the run is not mutated.",
    request: {
      params: z.object({ runId: z.string() }),
      body: CaptureRequestSchema,
    },
    responses: {
      200: { description: "Capture recorded", schema: CaptureResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Run not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/runs/:runId/capture", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const runId = c.req.param("runId");
    const raw = await c.req.json().catch(() => null);
    const parsed = CaptureRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400
      );
    }
    const body = parsed.data;

    try {
      // Load the run by id ONLY, then bind the acting identity to its workspace.
      const run = await db.query.playbookRuns.findFirst({
        where: eq(playbookRuns.id, runId),
      });
      if (!run) return c.json({ error: "Run not found" }, 404);

      // Resolve acting context within the run's OWN workspace — this both
      // verifies membership and closes the cross-tenant write (an agent can only
      // capture into a run whose workspace it belongs to).
      const acting = await resolveActingContext(c, {
        userId: body.agentUserId,
        workspaceId: run.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      if (run.workspaceId && run.workspaceId !== acting.workspaceId) {
        // No cross-tenant capture — same 404 as a missing run (no oracle).
        return c.json({ error: "Run not found" }, 404);
      }

      const agentUserId =
        body.agentUserId ??
        (c.get("agentUserId") as string | undefined) ??
        acting.userId;

      // Governance membrane decides approve vs propose.
      const perm = await checkPermissionOrPropose({
        userId: acting.userId,
        agentUserId: agentUserId !== acting.userId ? agentUserId : undefined,
        workspaceId: run.workspaceId,
        subjectType: "playbook_run",
        action: "update",
        source: "agent",
        data: { runId, status: body.status, summary: body.summary },
      });
      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return c.json({
          id: runId,
          status: run.status,
          proposalId: perm.proposalId,
        });
      }

      // Approved → update the run. Terminal statuses stamp completed_at.
      const nextStatus = body.status ?? run.status;
      const terminal =
        nextStatus === "completed" ||
        nextStatus === "failed" ||
        nextStatus === "proposed";
      const [updated] = await db
        .update(playbookRuns)
        .set({
          status: nextStatus,
          summary: body.summary ?? run.summary,
          error: body.error ?? run.error,
          completedAt: terminal ? new Date() : run.completedAt,
        })
        .where(eq(playbookRuns.id, runId))
        .returning();

      // Record produced entities as `session → produced → entity` links (the
      // provenance edge for what this run generated). VALIDATE each id resolves
      // to an entity in the run's OWN workspace before linking — a capture-back
      // caller must not fabricate provenance to arbitrary / cross-tenant ids.
      // Capped to bound the write.
      if (run.sessionId && run.workspaceId && body.producedEntityIds?.length) {
        const requested = body.producedEntityIds.slice(0, 100);
        const found = await db.query.entities.findMany({
          where: inArray(entities.id, requested),
          columns: { id: true, workspaceId: true },
        });
        const validIds = found
          .filter((e) => e.workspaceId === run.workspaceId)
          .map((e) => e.id);
        if (validIds.length) {
          await createLinks(
            validIds.map((entityId) => ({
              workspaceId: run.workspaceId,
              fromType: "session" as const,
              fromId: run.sessionId as string,
              toType: "entity" as const,
              toId: entityId,
              linkType: "produced" as const,
            }))
          );
        }
      }

      // Record invoked capabilities as `session → used → {tool|skill|command}` —
      // the provenance the session room's "Tools & skills" Frame reads, and what
      // promoteSessionToPlaybook re-grants. Capped; idempotent (links unique edge).
      if (run.sessionId && run.workspaceId && body.usedCapabilities?.length) {
        await createLinks(
          body.usedCapabilities.slice(0, 100).map((cap) => ({
            workspaceId: run.workspaceId,
            fromType: "session" as const,
            fromId: run.sessionId as string,
            toType: cap.kind,
            toId: cap.id,
            linkType: "used" as const,
          }))
        );
      }

      return c.json({
        id: updated.id,
        status: updated.status,
        proposalId: null,
      });
    } catch (err) {
      logger.error({ err, runId }, "runs.capture failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
