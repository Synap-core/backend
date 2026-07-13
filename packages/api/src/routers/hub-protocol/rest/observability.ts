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
import {
  AI_DECISION,
  AI_CORRECTION,
  AI_KIND,
  MATURITY_DAYS,
  clampWindowDays,
  decisionCorrelationKeyExpr,
  eventKindExpr,
  reasonCodeExpr,
} from "../../../lib/ai-events.js";

const ByReasonCodeSchema = z
  .object({
    reasonCode: z.string().nullable(),
    count: z.number(),
  })
  .openapi("RoutingHealthByReasonCode");

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
    /** Numeric bucket midpoint (0..1) — so consumers plot the calibration curve
     *  without parsing it back out of the `range` display string. */
    midpoint: z.number(),
    decisions: z.number(),
    corrected: z.number(),
    correctionRate: z.number().nullable(),
  })
  .openapi("RoutingHealthCalibrationBucket");

const RoutingHealthSchema = z
  .object({
    totalDecisions: z.number(),
    correctedDecisions: z.number(),
    // LEGACY headline — survivorship-biased (a decision counts as correct
    // unless someone bothered to move it) and rewards inaction. Kept for the
    // existing browser consumer; prefer `unattendedAcceptance` below.
    routingAccuracy: z.number().nullable(),
    appliedRate: z.number().nullable(),
    // HONEST headline — over the CohorT of auto-applied decisions old enough to
    // have been reversed (matured past MATURITY_DAYS), the fraction NOT reversed
    // by a move OR delete within that maturity window. Resists survivorship bias
    // (only falsifiable decisions count) and the "do nothing" exploit (no
    // auto-apply → no denominator → no credit). Null until the cohort is non-empty.
    unattendedAcceptance: z.number().nullable(),
    cohortSize: z.number(),
    cohortReversals: z.number(),
    maturityDays: z.number(),
    byTargetWorkspace: z.array(ByTargetWorkspaceSchema),
    calibration: z.array(CalibrationBucketSchema),
    // WHY users reject (Phase 1 reasoned-rejection loop): a breakdown of
    // structured `reasonCode`s carried on `ai_correction` (kind=extract)
    // events — i.e. whole-proposal rejects via `proposals.reject`/
    // `batchReject`. Independent of the routing (kind=route) decision/
    // correction data above; additive, doesn't touch existing fields.
    byReasonCode: z.array(ByReasonCodeSchema),
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
    const windowDays = clampWindowDays(
      parseInt(c.req.query("windowDays") ?? "30", 10) || undefined
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
          mode: drizzleSql<string | null>`${events.data}->>'mode'`,
          decidedAt: events.timestamp,
        })
        .from(events)
        .where(
          and(
            eq(events.userId, userId),
            eq(events.subjectType, AI_DECISION),
            drizzleSql`${eventKindExpr} = ${AI_KIND.ROUTE}`,
            gte(events.timestamp, since)
          )
        );

      const totalDecisions = decisionRows.length;

      // Reject reasonCode breakdown — independent of the ROUTE decision/
      // correction rows above (this reads EXTRACT corrections, i.e. whole-
      // proposal rejects), so compute it regardless of totalDecisions.
      const reasonCodeRows = await db
        .select({ reasonCode: reasonCodeExpr })
        .from(events)
        .where(
          and(
            eq(events.userId, userId),
            eq(events.subjectType, AI_CORRECTION),
            drizzleSql`${eventKindExpr} = ${AI_KIND.EXTRACT}`,
            gte(events.timestamp, since)
          )
        );
      const reasonCodeCounts = new Map<string | null, number>();
      for (const r of reasonCodeRows) {
        const key = r.reasonCode ?? null;
        reasonCodeCounts.set(key, (reasonCodeCounts.get(key) ?? 0) + 1);
      }
      const byReasonCode = Array.from(reasonCodeCounts.entries())
        .map(([reasonCode, count]) => ({ reasonCode, count }))
        .sort((a, b) => b.count - a.count);

      if (totalDecisions === 0) {
        return c.json(
          {
            totalDecisions: 0,
            correctedDecisions: 0,
            routingAccuracy: null,
            appliedRate: null,
            unattendedAcceptance: null,
            cohortSize: 0,
            cohortReversals: 0,
            maturityDays: MATURITY_DAYS,
            byTargetWorkspace: [],
            calibration: [],
            byReasonCode,
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
          decisionCorrelationId: decisionCorrelationKeyExpr,
        })
        .from(events)
        .where(
          and(
            eq(events.userId, userId),
            eq(events.subjectType, AI_CORRECTION),
            drizzleSql`${eventKindExpr} = ${AI_KIND.ROUTE}`,
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

      // Honest acceptance metric. Cohort = auto-applied decisions matured past
      // MATURITY_DAYS (they've had the full window to be reversed). A reversal =
      // a move (kind=route) OR delete (kind=extract) of that decision's entity
      // WITHIN MATURITY_DAYS of the decision (decision-anchored). Deletes are
      // included here even though the legacy `correctedDecisions` above ignores
      // them (`kind='route'` only).
      const maturityMs = MATURITY_DAYS * 24 * 60 * 60 * 1000;
      const nowMs = Date.now();
      const reversalRows = await db
        .select({
          decisionCorrelationId: decisionCorrelationKeyExpr,
          correctedAt: events.timestamp,
        })
        .from(events)
        .where(
          and(
            eq(events.userId, userId),
            eq(events.subjectType, AI_CORRECTION),
            drizzleSql`${eventKindExpr} IN (${AI_KIND.ROUTE}, ${AI_KIND.EXTRACT})`,
            gte(events.timestamp, since)
          )
        );
      // Earliest reversal per decision correlationId.
      const reversalTimeByCid = new Map<string, number>();
      for (const r of reversalRows) {
        if (!r.decisionCorrelationId) continue;
        const t = r.correctedAt.getTime();
        const prev = reversalTimeByCid.get(r.decisionCorrelationId);
        if (prev === undefined || t < prev)
          reversalTimeByCid.set(r.decisionCorrelationId, t);
      }
      const cohort = decisionRows.filter(
        (d) =>
          d.mode === "auto" &&
          d.applied === "true" &&
          nowMs - d.decidedAt.getTime() >= maturityMs
      );
      const cohortSize = cohort.length;
      const cohortReversals = cohort.filter((d) => {
        if (!d.correlationId) return false;
        const revAt = reversalTimeByCid.get(d.correlationId);
        return (
          revAt !== undefined &&
          revAt >= d.decidedAt.getTime() &&
          revAt <= d.decidedAt.getTime() + maturityMs
        );
      }).length;
      const unattendedAcceptance =
        cohortSize > 0 ? 1 - cohortReversals / cohortSize : null;

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
          // Numeric midpoint (clamp the last bucket's 1.01 "inclusive-of-1.0"
          // upper bound back to 1.0 so the plotted point stays in [0,1]).
          midpoint: (bucket.min + Math.min(bucket.max, 1)) / 2,
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
          unattendedAcceptance,
          cohortSize,
          cohortReversals,
          maturityDays: MATURITY_DAYS,
          byTargetWorkspace,
          calibration,
          byReasonCode,
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
