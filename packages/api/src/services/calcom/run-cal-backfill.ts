/**
 * Cal.com backfill poller — the safety net for the webhook.
 *
 * Runs on a schedule (jobs `cal-backfill-cron` → `registerCalBackfillRunner` IoC
 * slot). Lists upcoming Cal.com bookings via the `cal_list_bookings` capability
 * and turns any NOT-yet-seen booking into the same composite `capture/graph`
 * proposal the webhook builds — so a booking missed during pod downtime / webhook
 * misconfig still lands. Dedup is SHARED with the webhook: the `${uid}:BOOKING_CREATED`
 * seen-map under `metadata.calcom.webhook.seen`, so neither path double-captures.
 *
 * No-ops unless the cal_com tool has `metadata.calcom.backfill.enabled`. Lives in
 * @synap/api because `cal_list_bookings` (executeCapability) + submitCaptureGraph
 * are api-side; jobs invokes it in-process (jobs can't import @synap/api).
 */

import { db, tools, eq, drizzleSql } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { executeCapability } from "../capabilities/execute-capability.js";
import { submitCaptureGraph } from "../capture-agent/submit-capture-graph.js";
import { getCaptureAgentUserId } from "../capture-agent/ensure-capture-agent.js";
import {
  mapBookingToGraph,
  type CalBookingPayload,
} from "./map-booking-to-graph.js";

const logger = createLogger({ module: "cal-backfill" });

interface CalcomToolMetadata {
  calcom?: {
    webhook?: { workspaceId?: string | null; seen?: Record<string, string> };
    backfill?: { enabled?: boolean; connectionId?: string };
  };
  [k: string]: unknown;
}

export interface RunCalBackfillResult {
  skipped?: boolean;
  reason?: string;
  processed?: number;
  proposed?: number;
  alreadySeen?: number;
}

export async function runCalBackfill(): Promise<RunCalBackfillResult> {
  const calTool = await db.query.tools.findFirst({
    where: eq(tools.name, "cal_com"),
    columns: { id: true, createdBy: true, workspaceId: true, metadata: true },
  });
  if (!calTool) return { skipped: true, reason: "no_cal_tool" };

  const metadata = (calTool.metadata ?? {}) as CalcomToolMetadata;
  const backfill = metadata.calcom?.backfill;
  if (!backfill?.enabled) return { skipped: true, reason: "backfill_disabled" };

  const owner = calTool.createdBy;
  const workspaceId =
    metadata.calcom?.webhook?.workspaceId ?? calTool.workspaceId ?? null;
  const seen = metadata.calcom?.webhook?.seen ?? {};

  // List upcoming bookings via the capability (enriched responseShape → bookings[]).
  const cap = await executeCapability({
    verbId: "cal_list_bookings",
    parameters: { status: "upcoming" },
    userId: owner,
    workspaceId,
    connectionSelector: backfill.connectionId
      ? { connectionId: backfill.connectionId }
      : undefined,
  });
  if (cap.kind !== "run") {
    logger.warn(
      { capKind: cap.kind },
      "cal_list_bookings did not run — skipping"
    );
    return { skipped: true, reason: `cal_list_${cap.kind}` };
  }

  const result = cap.result as { bookings?: CalBookingPayload[] } | undefined;
  const bookings = Array.isArray(result?.bookings) ? result!.bookings : [];

  const actor = (await getCaptureAgentUserId()) ?? owner;
  // Keys added by THIS run only — the DB write below merges them into the
  // live column value in-statement, so a webhook firing mid-run can't be
  // clobbered by a whole-map snapshot write.
  const newKeys: Record<string, string> = {};
  let proposed = 0;
  let alreadySeen = 0;

  for (const booking of bookings) {
    const uid = booking.uid?.trim();
    if (!uid) continue;
    const key = `${uid}:BOOKING_CREATED`;
    if (seen[key] || newKeys[key]) {
      alreadySeen += 1;
      continue;
    }
    try {
      const { entities: graphEntities, relations } = mapBookingToGraph(booking);
      await submitCaptureGraph({
        userId: actor,
        workspaceId,
        entities: graphEntities,
        relations,
        summary: `Cal.com booking (backfill) — ${booking.title ?? uid}`,
      });
      newKeys[key] = new Date().toISOString();
      proposed += 1;
    } catch (err) {
      logger.warn({ err, uid }, "cal backfill: booking → graph failed");
    }
  }

  // Persist ONLY this run's new keys, merged into the live seen-map
  // IN-STATEMENT (row lock + re-evaluation makes the read-modify-write
  // race-safe vs concurrent webhook writes; a snapshot-based whole-map write
  // would clobber keys written mid-run). Nested jsonb_set chain creates any
  // missing parents; values are bound parameters, never interpolated.
  if (Object.keys(newKeys).length > 0) {
    await db
      .update(tools)
      .set({
        metadata: drizzleSql`jsonb_set(
          jsonb_set(
            jsonb_set(COALESCE(${tools.metadata}, '{}'::jsonb), '{calcom}', COALESCE(${tools.metadata}#>'{calcom}', '{}'::jsonb), true),
            '{calcom,webhook}', COALESCE(${tools.metadata}#>'{calcom,webhook}', '{}'::jsonb), true),
          '{calcom,webhook,seen}', COALESCE(${tools.metadata}#>'{calcom,webhook,seen}', '{}'::jsonb) || ${JSON.stringify(newKeys)}::jsonb, true)`,
        updatedAt: new Date(),
      })
      .where(eq(tools.id, calTool.id))
      .catch((err) =>
        logger.warn({ err }, "cal backfill: seen-map persist failed")
      );
  }

  logger.info(
    { processed: bookings.length, proposed, alreadySeen },
    "cal backfill run complete"
  );
  return { processed: bookings.length, proposed, alreadySeen };
}
