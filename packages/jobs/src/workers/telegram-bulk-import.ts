/**
 * Telegram Bulk Import Worker
 *
 * Processes a batch of pre-parsed Telegram contacts server-side.
 * Called by the relay-app after the client parses a Telegram Desktop export
 * JSON — the raw list of people is sent here so heavy entity creation + dedup
 * happens off the request thread.
 *
 * Queue: "telegram-bulk-import"
 *
 * Uses EntityUpsertService for all entity creation + dedup:
 *   1. entity_external_links exact match (fast, indexed)
 *   2. entity_identity_signals cross-source match (phone signal catches Telegram + device contacts)
 *   3. Create via EntityRepository (pod-wide scoping, indexing, event emission)
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";
import {
  getDb,
  EntityUpsertService,
  extractSignalsFromProperties,
  eventRepository,
} from "@synap/database";

const logger = createLogger({ module: "telegram-bulk-import" });

export const TELEGRAM_BULK_IMPORT_QUEUE = "telegram-bulk-import";

export interface TelegramPersonPayload {
  /** Telegram-side identifier — phone number or deterministic name-slug */
  externalId: string;
  name: string;
  phone?: string | null;
  username?: string | null;
  /** Number of messages exchanged (used for strength score) */
  messageCount?: number;
}

export interface TelegramBulkImportJobData {
  workspaceId: string;
  userId: string;
  people: TelegramPersonPayload[];
  taskId?: string;
}

const BATCH_SIZE = 25;

export async function handleTelegramBulkImport(
  job: PgBoss.Job<TelegramBulkImportJobData>
): Promise<void> {
  const { workspaceId, userId, people, taskId } = job.data;

  logger.info(
    { workspaceId, userId, total: people.length, taskId },
    "Starting Telegram bulk import"
  );

  if (!people.length) return;

  const db = await getDb();
  const upsertSvc = new EntityUpsertService(db, eventRepository);

  let created = 0;
  let updated = 0;
  let matched = 0;
  let failed = 0;

  for (let i = 0; i < people.length; i += BATCH_SIZE) {
    const batch = people.slice(i, i + BATCH_SIZE);

    for (const person of batch) {
      try {
        const strengthScore = person.messageCount
          ? Math.min(Math.round((person.messageCount / 50) * 100), 100)
          : 0;

        const properties = {
          phone: person.phone ?? null,
          telegramHandle: person.username ? `@${person.username}` : null,
          telegramPhone: person.phone ?? null,
          telegramMessageCount: person.messageCount ?? 0,
          sources: ["telegram"],
          strengthScore,
          lastInteractionAt: new Date().toISOString(),
          importedAt: new Date().toISOString(),
        };

        const result = await upsertSvc.upsert({
          profileSlug: "person",
          title: person.name,
          properties,
          source: "telegram",
          externalId: person.externalId,
          signals: extractSignalsFromProperties(properties, "telegram"),
          workspaceId,
          userId,
        });

        if (result.action === "created") created++;
        else if (result.action === "updated") updated++;
        else matched++;
      } catch (err) {
        logger.warn(
          { err, personName: person.name, personId: person.externalId },
          "Failed to import Telegram contact"
        );
        failed++;
      }
    }

    logger.info(
      {
        created,
        updated,
        matched,
        failed,
        processed: i + batch.length,
        total: people.length,
      },
      "Batch complete"
    );
  }

  logger.info(
    { workspaceId, created, updated, matched, failed, total: people.length },
    "Telegram bulk import complete"
  );
}
