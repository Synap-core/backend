/**
 * Hub Protocol REST — /observability (routing-health analysis).
 *
 * First observability analysis endpoint: computes routing accuracy from the
 * `ai_decision` (kind="route") and `ai_correction` (kind="route") events
 * recorded in the `events` table.
 *
 * Join: a decision is "corrected" when some correction's
 * `data->>'correlationId'` equals the decision's own `correlation_id` column
 * (NOT the correction row's own `correlation_id` column — the correction's
 * `correlation_id` is unrelated; the link lives inside its JSONB `data`).
 */

import { z } from "@hono/zod-openapi";

import {
  db,
  events,
  workspaces,
  eq,
  and,
  gte,
  inArray,
  drizzleSql,
} from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

const ByTargetWorkspaceSchema = z
  .object({
    workspaceId: z.string().nullable(),
    workspaceName: z.string(),
    decisions: z.number(),
    corrected: z.number(),
    correctionRate: z.number().nullable(),
  })
  .openapi("RoutingHealthByTargetWorkspace");

const CalibrationBucketSchema = z
  .object({
    range: z.string(),
    decisions: z.number(),
    corrected: z.number(),
    correctionRate: z.number().nullable(),
  })
  .openapi("RoutingHealthCalibrationBucket");

const RoutingHealthSchema = z
  .object({
    totalDecisions: z.number(),
    correctedDecisions: z.number(),
    routingAccuracy: z.number().nullable(),
    appliedRate: z.number().nullable(),
    byTargetWorkspace: z.array(ByTargetWorkspaceSchema),
    calibration: z.array(CalibrationBucketSchema),
    windowDays: z.number(),
    generatedAt: z.string(),
  })
  .openapi("RoutingHealth");

/** Confidence calibration buckets — [min, max) except the last, which is inclusive of 1.0. */
const CALIBRATION_BUCKETS: Array<{ min: number; max: number; range: string }> =
  [
    { min: 0, max: 0.5, range: "0.0–0.5" },
    { min: 0.5, max: 0.7, range: "0.5–0.7" },
    { min: 0.7, max: 0.85, range: "0.7–0.85" },
    { min: 0.85, max: 1.01, range: "0.85–1.0" },
  ];

export function registerObservabilityRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/observability/routing-health",
    tags: ["Observability"],
    summary: "AI capture-routing health (decision vs. correction events)",
    description:
      "Computes routing accuracy from ai_decision (kind=route) and " +
      "ai_correction (kind=route) events: overall accuracy, applied rate, a " +
      "per-target-workspace breakdown (which workspaces get mis-routed to), " +
      "and a confidence-calibration table (does stated confidence track real " +
      "accuracy). Returns nulls (never divide-by-zero) when there is no data " +
      "yet in the window.",
    responses: {
      200: {
        description: "Routing health report",
        schema: RoutingHealthSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  app.get("/observability/routing-health", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    // Read scoping: derive the acting user from the auth-middleware floor
    // (`c.get("userId")` already resolves is_internal→operator and
    // agent→linkedUserId), NEVER a caller-supplied `?userId=` param. Honoring
    // the query param — as the write-path `resolveActingContext` does for
    // service keys — let ANY hub-protocol.read key read another user's routing
    // telemetry (cross-user IDOR). This mirrors `getCaller`'s intentional
    // read-path asymmetry: caller-supplied userId is ignored on reads.
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);

    // Clamp the window: floor at 1 day, ceiling at 365 — an unbounded
    // `windowDays` (e.g. 1_000_000) would widen the per-user event scan and
    // in-memory aggregation without limit, a cheap DoS multiplier a caller
    // could hammer against the pod's edge rate limit.
    const windowDays = Math.min(
      365,
      Math.max(1, parseInt(c.req.query("windowDays") ?? "30", 10) || 30)
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    try {
      // 1) All routing decisions for this user in the window.
      const decisionRows = await db
        .select({
          correlationId: events.correlationId,
          chosenWorkspaceId: drizzleSql<
            string | null
          >`${events.data}->>'chosenWorkspaceId'`,
          confidence: drizzleSql<string | null>`${events.data}->>'confidence'`,
          applied: drizzleSql<string | null>`${events.data}->>'applied'`,
        })
        .from(events)
        .where(
          and(
            eq(events.userId, userId),
            eq(events.subjectType, "ai_decision"),
            drizzleSql`${events.data}->>'kind' = 'route'`,
            gte(events.timestamp, since)
          )
        );

      const totalDecisions = decisionRows.length;

      if (totalDecisions === 0) {
        return c.json(
          {
            totalDecisions: 0,
            correctedDecisions: 0,
            routingAccuracy: null,
            appliedRate: null,
            byTargetWorkspace: [],
            calibration: [],
            windowDays,
            generatedAt: new Date().toISOString(),
          },
          200
        );
      }

      // 2) All routing corrections for this user in the window, keyed by the
      //    correlationId embedded in `data` (the join key — NOT the
      //    correction row's own correlation_id column).
      const correctionRows = await db
        .select({
          decisionCorrelationId: drizzleSql<
            string | null
          >`${events.data}->>'correlationId'`,
        })
        .from(events)
        .where(
          and(
            eq(events.userId, userId),
            eq(events.subjectType, "ai_correction"),
            drizzleSql`${events.data}->>'kind' = 'route'`,
            gte(events.timestamp, since)
          )
        );

      const correctedCorrelationIds = new Set(
        correctionRows
          .map((r) => r.decisionCorrelationId)
          .filter((id): id is string => !!id)
      );

      const isCorrected = (correlationId: string | null): boolean =>
        !!correlationId && correctedCorrelationIds.has(correlationId);

      const correctedDecisions = decisionRows.filter((d) =>
        isCorrected(d.correlationId)
      ).length;

      const appliedDecisions = decisionRows.filter(
        (d) => d.applied === "true"
      ).length;

      // 3) Group by target (chosen) workspace.
      const byWsMap = new Map<
        string,
        { decisions: number; corrected: number }
      >();
      for (const d of decisionRows) {
        const wsId = d.chosenWorkspaceId ?? "unknown";
        const entry = byWsMap.get(wsId) ?? { decisions: 0, corrected: 0 };
        entry.decisions += 1;
        if (isCorrected(d.correlationId)) entry.corrected += 1;
        byWsMap.set(wsId, entry);
      }

      const knownWsIds = Array.from(byWsMap.keys()).filter(
        (id) => id !== "unknown"
      );
      const wsNameRows = knownWsIds.length
        ? await db
            .select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .where(inArray(workspaces.id, knownWsIds))
        : [];
      const wsNameById = new Map(wsNameRows.map((w) => [w.id, w.name]));

      const byTargetWorkspace = Array.from(byWsMap.entries())
        .map(([wsId, { decisions, corrected }]) => ({
          workspaceId: wsId === "unknown" ? null : wsId,
          workspaceName:
            wsId === "unknown"
              ? "Unknown"
              : (wsNameById.get(wsId) ?? "Unknown"),
          decisions,
          corrected,
          correctionRate: decisions > 0 ? corrected / decisions : null,
        }))
        .sort((a, b) => b.decisions - a.decisions);

      // 4) Confidence calibration buckets.
      const calibration = CALIBRATION_BUCKETS.map((bucket) => {
        const inBucket = decisionRows.filter((d) => {
          const conf = d.confidence !== null ? Number(d.confidence) : null;
          return conf !== null && conf >= bucket.min && conf < bucket.max;
        });
        const decisionsCount = inBucket.length;
        const correctedCount = inBucket.filter((d) =>
          isCorrected(d.correlationId)
        ).length;
        return {
          range: bucket.range,
          decisions: decisionsCount,
          corrected: correctedCount,
          correctionRate:
            decisionsCount > 0 ? correctedCount / decisionsCount : null,
        };
      });

      return c.json(
        {
          totalDecisions,
          correctedDecisions,
          routingAccuracy:
            totalDecisions > 0 ? 1 - correctedDecisions / totalDecisions : null,
          appliedRate:
            totalDecisions > 0 ? appliedDecisions / totalDecisions : null,
          byTargetWorkspace,
          calibration,
          windowDays,
          generatedAt: new Date().toISOString(),
        },
        200
      );
    } catch (err) {
      logger.warn({ err, userId }, "observability/routing-health failed");
      return c.json({ error: "Failed to compute routing health" }, 500);
    }
  });
}
