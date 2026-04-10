/**
 * LinkedIn Bulk Import Worker
 *
 * Processes a batch of pre-parsed LinkedIn connections server-side.
 * Called by the relay-app after the client parses a LinkedIn Connections.csv.
 *
 * Queue: "linkedin-bulk-import"
 *
 * Uses EntityUpsertService for all entity creation + dedup:
 *   1. entity_external_links exact match (fast, indexed)
 *   2. entity_identity_signals cross-source match (email signal catches LinkedIn + device contacts)
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
import { randomUUID } from "crypto";
import { emitSideEffects } from "../emit-side-effects.js";

const logger = createLogger({ module: "linkedin-bulk-import" });

export const LINKEDIN_BULK_IMPORT_QUEUE = "linkedin-bulk-import";

export interface LinkedInContactPayload {
  /** Stable ID — email if available, else deterministic name-slug */
  externalId: string;
  name: string;
  email?: string | null;
  company?: string | null;
  role?: string | null;
  connectedOn?: string | null;
}

export interface LinkedInBulkImportJobData {
  workspaceId: string;
  userId: string;
  contacts: LinkedInContactPayload[];
}

const BATCH_SIZE = 25;

export async function handleLinkedInBulkImport(
  job: PgBoss.Job<LinkedInBulkImportJobData>
): Promise<void> {
  const { workspaceId, userId, contacts } = job.data;

  logger.info(
    { workspaceId, userId, total: contacts.length },
    "Starting LinkedIn bulk import"
  );

  if (!contacts.length) return;

  const db = await getDb();
  const upsertSvc = new EntityUpsertService(db, eventRepository);

  let created = 0;
  let updated = 0;
  let matched = 0;
  let failed = 0;

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);

    for (const contact of batch) {
      try {
        // Use 'contact' profile when company/role are present (inherits person, adds those fields)
        const profileSlug =
          contact.company || contact.role ? "contact" : "person";

        const properties = {
          email: contact.email ?? null,
          company: contact.company ?? null,
          role: contact.role ?? null,
          linkedinConnectedOn: contact.connectedOn ?? null,
          sources: ["linkedin"],
          importedAt: new Date().toISOString(),
        };

        const result = await upsertSvc.upsert({
          profileSlug,
          title: contact.name,
          properties,
          source: "linkedin",
          externalId: contact.externalId,
          signals: extractSignalsFromProperties(properties, "linkedin"),
          workspaceId,
          userId,
        });

        if (result.action === "created") created++;
        else if (result.action === "updated") updated++;
        else matched++;
      } catch (err) {
        logger.warn(
          { err, contactName: contact.name, contactId: contact.externalId },
          "Failed to import LinkedIn contact"
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
        total: contacts.length,
      },
      "Batch complete"
    );
  }

  logger.info(
    { workspaceId, created, updated, matched, failed, total: contacts.length },
    "LinkedIn bulk import complete"
  );

  // Emit connector_sync event — enables automation triggers + event log audit trail
  const syncEventId = randomUUID();
  const syncData = {
    provider: "linkedin",
    workspaceId,
    entitiesCreated: created,
    entitiesUpdated: updated,
    entitiesMatched: matched,
    failed,
    syncStatus: failed === contacts.length ? "error" : "success",
  };

  emitSideEffects({
    subjectType: "connector_sync",
    action: "complete",
    subjectId: syncEventId,
    userId,
    workspaceId,
    data: syncData,
  }).catch(() => {});

  eventRepository
    .append({
      id: syncEventId,
      version: "v1",
      type: "connector_sync.complete.completed",
      subjectType: "connector_sync",
      data: syncData,
      userId,
      source: "system",
      timestamp: new Date(),
    })
    .catch(() => {});
}
