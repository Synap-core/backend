/**
 * Fireflies backfill poller — the safety net for the inbound webhook.
 *
 * Runs on a schedule (jobs `fireflies-backfill-cron` → `registerFirefliesBackfillRunner`
 * IoC slot). Lists recent transcripts via the `fireflies_list_recent_transcripts`
 * declarative verb and re-runs the SAME fetch→recordInboundMessage ingest for any
 * transcript NOT yet in the shared seen-map — so a meeting whose completion webhook
 * was missed (pod down / webhook misconfig) still lands. Dedup is SHARED with the
 * webhook: `metadata.fireflies.webhook.seen` keyed on meetingId, so neither path
 * double-ingests (and recordInboundMessage is idempotent as a second guard).
 *
 * No-ops unless the fireflies tool has `metadata.fireflies.backfill.enabled`.
 * There is NO rate-limiter in the shared dispatch path, so we throttle CALLER-side
 * here (spacing between per-transcript fetches) to stay under Fireflies' 60 req/min.
 *
 * Lives in @synap/api because runFirefliesIngest (executeCapability +
 * recordInboundMessage) is api-side; jobs invokes it in-process (IoC slot).
 */

import { db, tools, eq } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { executeCapability } from "../capabilities/execute-capability.js";
import { runFirefliesIngest } from "./run-fireflies-ingest.js";

const logger = createLogger({ module: "fireflies-backfill" });

// Spacing between per-transcript fetches. Fireflies' business rate limit is
// 60 req/min; ~1.2s spacing keeps us at ≤50/min with headroom for the list call.
const THROTTLE_MS = 1200;

interface FirefliesToolMetadata {
  fireflies?: {
    webhook?: { workspaceId?: string | null; seen?: Record<string, string> };
    backfill?: { enabled?: boolean };
  };
  [k: string]: unknown;
}

export interface RunFirefliesBackfillResult {
  skipped?: boolean;
  reason?: string;
  processed?: number;
  ingested?: number;
  alreadySeen?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function runFirefliesBackfill(): Promise<RunFirefliesBackfillResult> {
  const ffTool = await db.query.tools.findFirst({
    where: eq(tools.name, "fireflies"),
    columns: { id: true, createdBy: true, workspaceId: true, metadata: true },
  });
  if (!ffTool) return { skipped: true, reason: "no_fireflies_tool" };

  const metadata = (ffTool.metadata ?? {}) as FirefliesToolMetadata;
  if (!metadata.fireflies?.backfill?.enabled)
    return { skipped: true, reason: "backfill_disabled" };

  const owner = ffTool.createdBy;
  const workspaceId =
    metadata.fireflies?.webhook?.workspaceId ?? ffTool.workspaceId ?? null;
  const seen = metadata.fireflies?.webhook?.seen ?? {};

  const cap = await executeCapability({
    verbId: "fireflies_list_recent_transcripts",
    parameters: {},
    userId: owner,
    workspaceId,
  });
  if (cap.kind !== "run") {
    logger.warn(
      { capKind: cap.kind },
      "fireflies_list_recent_transcripts did not run — skipping"
    );
    return { skipped: true, reason: `list_${cap.kind}` };
  }

  const result = cap.result as
    { results?: { id?: string | null }[] } | undefined;
  const rows = Array.isArray(result?.results) ? result!.results! : [];

  let ingested = 0;
  let alreadySeen = 0;
  let processed = 0;

  for (const row of rows) {
    const meetingId = (row?.id ?? "").toString().trim();
    if (!meetingId) continue;
    if (seen[meetingId]) {
      alreadySeen += 1;
      continue;
    }
    processed += 1;
    try {
      // Same door as the webhook path; runFirefliesIngest re-fetches, lands the
      // message and marks the shared seen-map itself.
      const r = await runFirefliesIngest({
        meetingId,
        toolId: ffTool.id,
        workspaceId,
        ownerUserId: owner,
      });
      if (!r.skipped) ingested += 1;
    } catch (err) {
      logger.warn({ err, meetingId }, "fireflies backfill: ingest failed");
    }
    // Caller-side throttle to respect the 60 req/min business limit.
    await sleep(THROTTLE_MS);
  }

  logger.info(
    { total: rows.length, processed, ingested, alreadySeen },
    "fireflies backfill run complete"
  );
  return { processed, ingested, alreadySeen };
}
