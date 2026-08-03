/**
 * Fireflies transcript ingest — fetch-then-land, the body of the queue worker.
 *
 * Called by the `fireflies-ingest` pg-boss worker (webhook-triggered) AND by the
 * backfill poller. Given a meetingId it:
 *   1) fetches the full transcript via the `fireflies_get_transcript` DECLARATIVE
 *      GraphQL verb (governed as a READ — auto-runs, no proposal), through the ONE
 *      capability door `executeCapability`;
 *   2) maps it to a message shape with the pure `mapTranscriptToMessage`;
 *   3) lands it as a channel MESSAGE via the ONE inbound door `recordInboundMessage`
 *      (race-safe channel resolve + idempotent insert + `external_message.received`
 *      side-effects) — so the transcript is immediately queryable by the AI;
 *   4) marks `meetingId` in the SHARED seen-map (metadata.fireflies.webhook.seen)
 *      via a race-safe in-statement jsonb_set — but ONLY after the message landed,
 *      so a fetch/ingest failure leaves it unseen for the backfill poller to retry.
 *
 * Lives in @synap/api because executeCapability + recordInboundMessage are api-side;
 * @synap/jobs invokes it in-process via the `firefliesIngestRunner` IoC slot.
 */

import { createLogger } from "@synap-core/core";
import { executeCapability } from "../capabilities/execute-capability.js";
import { recordInboundMessage } from "../connectors/inbound-recorder.js";
import { markWebhookSeen } from "../connectors/mark-webhook-seen.js";
import { mapTranscriptToMessage } from "./map-transcript-to-message.js";
import type { FirefliesTranscript } from "./map-transcript-to-message.js";

const logger = createLogger({ module: "fireflies-ingest" });

export const FIREFLIES_PROVIDER = "fireflies";

export interface RunFirefliesIngestInput {
  meetingId: string;
  clientReferenceId?: string | null;
  /** The fireflies tool row id (resolved by the webhook / backfill). */
  toolId: string;
  workspaceId?: string | null;
  ownerUserId: string;
}

export interface RunFirefliesIngestResult {
  skipped?: boolean;
  reason?: string;
  recorded?: boolean;
  channelId?: string;
}

/** Race-safe single-key merge into metadata.fireflies.webhook.seen (shared door). */
async function markSeen(toolId: string, meetingId: string): Promise<void> {
  await markWebhookSeen(toolId, FIREFLIES_PROVIDER, meetingId);
}

export async function runFirefliesIngest(
  input: RunFirefliesIngestInput
): Promise<RunFirefliesIngestResult> {
  const { meetingId, toolId, ownerUserId } = input;
  const workspaceId = input.workspaceId ?? null;
  const clientReferenceId = input.clientReferenceId?.trim() || undefined;

  // 1) Fetch the transcript through the declarative GraphQL read verb.
  const cap = await executeCapability({
    verbId: "fireflies_get_transcript",
    parameters: { id: meetingId },
    userId: ownerUserId,
    workspaceId,
  });
  if (cap.kind === "error") {
    // Throw so the pg-boss worker retries; the backfill poller is the last net.
    throw new Error(`fireflies_get_transcript failed: ${cap.message}`);
  }
  if (cap.kind !== "run") {
    logger.warn(
      { meetingId, capKind: cap.kind },
      "fireflies_get_transcript did not run — skipping"
    );
    return { skipped: true, reason: `get_transcript_${cap.kind}` };
  }

  const result = cap.result as
    { transcript?: FirefliesTranscript | null } | undefined;
  const transcript = result?.transcript ?? null;
  if (!transcript) {
    logger.warn(
      { meetingId },
      "fireflies: transcript empty — nothing to ingest"
    );
    return { skipped: true, reason: "empty_transcript" };
  }

  // 2) Pure mapping → message shape.
  const mapped = mapTranscriptToMessage(transcript, meetingId);

  // 3) Land it as a channel message via the ONE inbound door. Identity binding:
  //    clientReferenceId (Fireflies' user-supplied upload id) is the strong
  //    external-id signal when present — resolveOrCreateExternalChannel links the
  //    channel at birth via `fireflies:<clientReferenceId>`. Otherwise the channel
  //    is left unlinked for the review queue (email-only auto-linking is not done
  //    by the channel resolver — it links on external_id, matching Discord/Unipile).
  const record = await recordInboundMessage({
    provider: FIREFLIES_PROVIDER,
    externalId: meetingId,
    userId: ownerUserId,
    workspaceId,
    text: mapped.text,
    title: mapped.title,
    participant: mapped.primaryParticipant?.name ?? mapped.title,
    participantExternalId: clientReferenceId,
    idempotencySeed: meetingId,
    sentAt: mapped.sentAt,
    messageId: meetingId,
  });

  // 4) Mark seen only now that the message landed (idempotent duplicate counts as
  //    handled → still mark).
  await markSeen(toolId, meetingId);

  logger.info(
    { meetingId, channelId: record.channelId, recorded: record.recorded },
    "fireflies: transcript ingested"
  );
  return {
    recorded: record.recorded,
    channelId: record.channelId,
  };
}
