/**
 * Inbound attachment ingest runner (api-side).
 *
 * Fills the `INBOUND_ATTACHMENT_QUEUE` IoC slot (registered by apps/api at boot).
 * For an inbound message that carried attachments, this fetches each url's bytes
 * OFF the sensor path and lands them through the CANONICAL doors — nothing is
 * hand-rolled here:
 *   • fetch      → `safeExternalFetch` + `validateExternalUrl` SSRF guard
 *                  (the same door the automation `fetch` node uses),
 *   • store      → `createGovernedFileEntityFromBuffer` (blob → documents row +
 *                  immutable v1 → GOVERNED `entities.create` for the `file` kind),
 *   • link       → a `channel_context_items` REFERENCED row bound to the channel
 *                  AND the source message, plus the file entity id folded back
 *                  into the message's `metadata.attachments` cache.
 *
 * Best-effort per attachment: one bad/expired/oversized url is logged and
 * skipped; the rest still land. The message + its {type,url} metadata preview
 * were already recorded synchronously, so a total failure here loses no message.
 */

import {
  db,
  eq,
  drizzleSql,
  messages,
  channelContextItems,
  workspaceMembers,
  ChannelContextObjectType,
  ChannelContextRelationshipType,
} from "@synap/database";
import { validateExternalUrl, safeExternalFetch } from "@synap/shared-utils";
import { createLogger } from "@synap-core/core";
import type { InboundAttachmentJobData } from "@synap/jobs/workers/inbound-attachment-worker.js";
import { createGovernedFileEntityFromBuffer } from "../../routers/create-governed-file-entity.js";

const logger = createLogger({ module: "ingest-inbound-attachments" });

/** Refuse to buffer more than this per attachment (defensive; pre-store bound). */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB
/** Sensor-side ingest acts as the pod owner (human provenance) via the hub door. */
const INGEST_SCOPES = ["hub-protocol.read", "hub-protocol.write"];

interface AttachmentIngestResult {
  stored: number;
  skipped: number;
}

/** Derive a filename from an explicit name or the url path; never empty. */
function deriveFilename(name: string | undefined, url: string): string {
  if (name && name.trim()) return name.trim();
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // fall through
  }
  return "attachment";
}

export async function runInboundAttachmentIngest(
  input: InboundAttachmentJobData
): Promise<AttachmentIngestResult> {
  // The governed `file` door needs a workspace for the storage path + lens even
  // when the `file` kind is pod-scoped. A pod-wide inbound (null workspace)
  // falls back to any workspace the owner belongs to; if none, we can't store.
  let workspaceId = input.workspaceId;
  if (!workspaceId) {
    const membership = await db.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, input.userId),
      columns: { workspaceId: true },
    });
    workspaceId = membership?.workspaceId ?? null;
  }
  if (!workspaceId) {
    logger.warn(
      { userId: input.userId, messageId: input.messageId },
      "inbound-attachment: no workspace to store attachments — skipping"
    );
    return { stored: 0, skipped: input.attachments.length };
  }

  let stored = 0;
  let skipped = 0;
  // url → freshly-minted file entity id, folded back into message metadata.
  const linkedByUrl = new Map<string, string>();

  for (const att of input.attachments.slice(0, 8)) {
    try {
      const urlCheck = validateExternalUrl(att.url);
      if (!urlCheck.valid) {
        logger.warn(
          { url: att.url, reason: urlCheck.reason, messageId: input.messageId },
          "inbound-attachment: url blocked by SSRF guard — skipping"
        );
        skipped++;
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let buffer: Buffer;
      let mimeType: string;
      try {
        const res = await safeExternalFetch(att.url, {
          method: "GET",
          signal: controller.signal,
        });
        if (!res.ok) {
          logger.warn(
            { url: att.url, status: res.status, messageId: input.messageId },
            "inbound-attachment: fetch non-2xx — skipping"
          );
          skipped++;
          continue;
        }
        const arrayBuf = await res.arrayBuffer();
        if (
          arrayBuf.byteLength === 0 ||
          arrayBuf.byteLength > MAX_ATTACHMENT_BYTES
        ) {
          logger.warn(
            {
              url: att.url,
              bytes: arrayBuf.byteLength,
              messageId: input.messageId,
            },
            "inbound-attachment: empty or oversized — skipping"
          );
          skipped++;
          continue;
        }
        buffer = Buffer.from(arrayBuf);
        mimeType =
          res.headers.get("content-type")?.split(";")[0]?.trim() ||
          att.type ||
          "application/octet-stream";
      } finally {
        clearTimeout(timer);
      }

      // Store through the GOVERNED file door (no agentUserId → owner/human
      // provenance, auto-applies when `entity.create ∈ DEFAULT_AUTO_APPROVE`).
      const result = await createGovernedFileEntityFromBuffer({
        buffer,
        mimeType,
        filename: deriveFilename(att.name, att.url),
        userId: input.userId,
        workspaceId,
        scopes: INGEST_SCOPES,
      });

      if (result.status !== "created") {
        // Stricter workspace policy filed a proposal — the file lands on
        // approval but can't be linked to the message now. Rare for `file`.
        logger.info(
          { messageId: input.messageId, url: att.url },
          "inbound-attachment: file create proposed (not linked to message)"
        );
        skipped++;
        continue;
      }

      // Link the file entity to the channel AND the source message. REFERENCED
      // is the "this object was attached to a message" relationship; the unique
      // (channel, object, type, relationship) index makes re-runs idempotent.
      await db
        .insert(channelContextItems)
        .values({
          channelId: input.channelId,
          objectType: ChannelContextObjectType.ENTITY,
          objectId: result.fileEntityId,
          relationshipType: ChannelContextRelationshipType.REFERENCED,
          sourceMessageId: input.messageId,
          userId: input.userId,
          workspaceId,
        })
        .onConflictDoNothing();

      linkedByUrl.set(att.url, result.fileEntityId);
      stored++;
    } catch (err) {
      logger.warn(
        { err, url: att.url, messageId: input.messageId },
        "inbound-attachment: ingest of one attachment failed — skipping"
      );
      skipped++;
    }
  }

  // Fold the minted entity ids back into the message's attachments cache so the
  // inbox can render the stored file (not just the raw url). Read-modify-write:
  // this job is the only writer of these entityIds and runs once per message.
  if (linkedByUrl.size > 0) {
    try {
      const row = await db.query.messages.findFirst({
        where: eq(messages.id, input.messageId),
        columns: { metadata: true },
      });
      const meta = (row?.metadata ?? {}) as Record<string, unknown>;
      const existing = Array.isArray(meta.attachments)
        ? (meta.attachments as Array<Record<string, unknown>>)
        : [];
      const patched = existing.map((a) => {
        const url = typeof a.url === "string" ? a.url : undefined;
        const entityId = url ? linkedByUrl.get(url) : undefined;
        return entityId ? { ...a, entityId } : a;
      });
      await db
        .update(messages)
        .set({
          metadata: drizzleSql`COALESCE(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify(
            { attachments: patched }
          )}::jsonb`,
        })
        .where(eq(messages.id, input.messageId));
    } catch (err) {
      logger.warn(
        { err, messageId: input.messageId },
        "inbound-attachment: message metadata patch failed (files still stored+linked)"
      );
    }
  }

  return { stored, skipped };
}
