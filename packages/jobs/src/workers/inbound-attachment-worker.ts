/**
 * Inbound Attachment Worker — fetch-then-store inbound message attachments.
 *
 * The inbound sensor recorder (`recordInboundMessage`, @synap/api) records a
 * message with its attachments as METADATA (bounded {type,url}) synchronously,
 * then enqueues ONE job here per inbound message so the real bytes are fetched
 * OFF the request path. This handler delegates to an api-side runner that:
 *   • SSRF-guards + fetches each attachment url,
 *   • stores the bytes through the GOVERNED `file` door
 *     (`createGovernedFileEntityFromBuffer`), and
 *   • links the resulting `file` entity to the channel + message.
 *
 * @synap/jobs cannot statically import @synap/api (circular dep: api → jobs →
 * database), so apps/api fills the runner slot at boot via
 * `registerInboundAttachmentIngestRunner()` — the same IoC pattern as
 * fireflies-ingest / mail-feed.
 *
 * Failure posture: SWALLOWS (like a best-effort media backfill). Attachments are
 * a value-add on top of an already-recorded message; a bad/expired url must not
 * retry-storm. Per-attachment errors are isolated inside the runner.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "inbound-attachment-worker" });

export const INBOUND_ATTACHMENT_QUEUE = "inbound-attachment-ingest";

/** One inbound attachment (mirrors the Discord/inbound {type,url,name?} shape). */
export interface InboundAttachment {
  type: string;
  url: string;
  name?: string;
}

/** Job payload the recorder enqueues onto INBOUND_ATTACHMENT_QUEUE. */
export interface InboundAttachmentJobData {
  channelId: string;
  /** The stored `messages` row id the attachments belong to. */
  messageId: string;
  userId: string;
  /** Channel workspace home; null for a pod-wide inbound (runner resolves one). */
  workspaceId: string | null;
  provider: string;
  attachments: InboundAttachment[];
}

type InboundAttachmentRunner = (
  input: InboundAttachmentJobData
) => Promise<unknown>;

let inboundAttachmentRunner: InboundAttachmentRunner | null = null;

export function registerInboundAttachmentIngestRunner(
  fn: InboundAttachmentRunner
): void {
  inboundAttachmentRunner = fn;
}

export async function handleInboundAttachmentIngest(
  job: PgBoss.Job
): Promise<void> {
  if (!inboundAttachmentRunner) {
    logger.warn("inbound-attachment runner not registered — skipping job");
    return;
  }
  const data = job.data as InboundAttachmentJobData;
  if (!data?.messageId || !data?.channelId || !data?.attachments?.length) {
    logger.warn(
      { data },
      "inbound-attachment: malformed job payload — dropping"
    );
    return;
  }
  try {
    const result = await inboundAttachmentRunner(data);
    logger.info(
      { messageId: data.messageId, count: data.attachments.length, result },
      "inbound-attachment ingest complete"
    );
  } catch (err) {
    // Best-effort media — swallow so pg-boss doesn't retry-storm a bad url.
    logger.warn(
      { err, messageId: data.messageId },
      "inbound-attachment ingest failed (non-fatal, no retry)"
    );
  }
}
