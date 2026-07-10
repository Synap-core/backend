/**
 * EntityUpsertService — Cross-Source Identity Resolution
 *
 * The "same person" problem: a contact imported from Telegram (by phone) and
 * from LinkedIn (by email) creates two separate entities. This service solves
 * that by maintaining an identity signals table that maps stable identifiers
 * (email, phone, profile URLs) to entity IDs — across all sources.
 *
 * Upsert flow:
 *  1. Check entity_external_links by (provider, externalId) — exact re-import
 *  2. Check entity_identity_signals for any matching signal — cross-source match
 *  3. No match → EntityRepository.create() + register all signals + external link
 *
 * Each call also registers new signals for the matched entity, so future imports
 * from other sources that share any signal will resolve to the same entity.
 *
 * Usage:
 *   const svc = new EntityUpsertService(db, eventRepository);
 *   const result = await svc.upsert({
 *     profileSlug: 'person',
 *     title: 'John Smith',
 *     properties: { email: 'john@co.com', phone: '+33612345678' },
 *     source: 'linkedin',
 *     externalId: 'li-email-john@co.com',
 *     signals: [
 *       { type: 'email', value: 'john@co.com' },
 *       { type: 'phone', value: '+33612345678' },
 *     ],
 *     workspaceId: 'ws-uuid',
 *     userId: 'user-uuid',
 *   });
 *   // result.action = 'created' | 'updated'
 */

import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { entityExternalLinks, entities } from "../schema/index.js";
import type * as schema from "../schema/index.js";
import type { Entity } from "../schema/entities.js";
import { EntityRepository } from "../repositories/entity-repository.js";
import type { EventRepository } from "../repositories/event-repository.js";
import {
  resolveIdentity,
  registerIdentitySignals,
  normalizeIdentitySignal,
  extractIdentitySignals,
  type IdentitySignal,
} from "./identity-resolution-service.js";

export type { IdentitySignal };

export interface EntityUpsertInput {
  profileSlug: string;
  title: string;
  properties: Record<string, unknown>;
  /** Source name: 'telegram' | 'linkedin' | 'contacts' | 'connector:google-contacts' | ... */
  source: string;
  /** Stable provider-specific ID (phone, email, profile URL slug). Stored in entity_external_links. */
  externalId: string;
  /** Identity signals extracted from this record — used for cross-source matching. */
  signals: IdentitySignal[];
  /**
   * Workspace context for the upsert. Pass `null` for pod-wide profiles
   * (entityScope='pod') — EntityRepository resolves the effective scope from
   * the profile and may still persist with `workspace_id = null`.
   */
  workspaceId: string | null;
  userId: string;
}

export interface EntityUpsertResult {
  entity: Entity;
  /** 'created' = new entity. 'updated' = same externalId seen before. 'matched' = cross-source signal match. */
  action: "created" | "updated" | "matched";
}

/** nangoConnectionId sentinel for non-OAuth imports */
const DIRECT_IMPORT_CONNECTION_ID = "direct-import";

export class EntityUpsertService {
  private entityRepo: EntityRepository;

  constructor(
    private db: PostgresJsDatabase<typeof schema>,
    eventRepo: EventRepository
  ) {
    this.entityRepo = new EntityRepository(db, eventRepo);
  }

  /**
   * Upsert an entity with cross-source identity resolution.
   * Always idempotent — safe to call multiple times for the same contact.
   */
  async upsert(input: EntityUpsertInput): Promise<EntityUpsertResult> {
    const normalizedSignals = input.signals.map((s) => ({
      type: s.type,
      value: normalizeIdentitySignal(s.type, s.value),
    }));

    // ── Step 1: Exact re-import check (entity_external_links) ─────────────────
    const existingLink = await this.db.query.entityExternalLinks.findFirst({
      where: and(
        eq(entityExternalLinks.provider, input.source),
        eq(entityExternalLinks.externalId, input.externalId)
      ),
      columns: { entityId: true },
    });

    if (existingLink) {
      const entity = await this.db.query.entities.findFirst({
        where: eq(entities.id, existingLink.entityId),
      });
      if (entity) {
        // Register any new signals that weren't present before
        await this.registerSignals(entity.id, normalizedSignals, input.source);
        return { entity: entity as Entity, action: "updated" };
      }
    }

    // ── Step 2: Cross-source signal match (STRONG identity, via the SSOT) ───────
    // Also look up the (source, externalId) pair as a strong `external_id`
    // signal: the external-link idempotency door registers writes under exactly
    // this key, so this is the read side that lets a re-import resolve to the
    // same subject via the signal layer — belt to Step 1's external-links belt.
    const lookupSignals: IdentitySignal[] = [...normalizedSignals];
    if (input.externalId) {
      lookupSignals.push({
        type: "external_id",
        value: `${input.source}:${input.externalId}`,
      });
    }
    if (lookupSignals.length > 0) {
      const resolution = await resolveIdentity(this.db, {
        userId: input.userId,
        signals: lookupSignals,
      });

      if (resolution.match === "strong" && resolution.entity) {
        // Load the full row — the SSOT returns a minimal projection.
        const entity = await this.db.query.entities.findFirst({
          where: eq(entities.id, resolution.entity.id),
        });
        if (entity) {
          // Register this external link so future re-imports are exact-matched (Step 1)
          await this.registerExternalLink(
            entity.id,
            input.source,
            input.externalId
          );
          // Register any new signals for this entity
          await this.registerSignals(
            entity.id,
            normalizedSignals,
            input.source
          );
          return { entity: entity as Entity, action: "matched" };
        }
      }
    }

    // ── Step 3: Create new entity ─────────────────────────────────────────────
    const entity = await this.entityRepo.create(
      {
        profileSlug: input.profileSlug,
        title: input.title,
        properties: input.properties,
        workspaceId: input.workspaceId,
        userId: input.userId,
        skipValidation: true,
      },
      input.userId
    );

    await Promise.all([
      this.registerExternalLink(entity.id, input.source, input.externalId),
      this.registerSignals(entity.id, normalizedSignals, input.source),
    ]);

    return { entity, action: "created" };
  }

  private async registerExternalLink(
    entityId: string,
    provider: string,
    externalId: string
  ): Promise<void> {
    await this.db
      .insert(entityExternalLinks)
      .values({
        entityId,
        provider,
        externalId,
        nangoConnectionId: DIRECT_IMPORT_CONNECTION_ID,
        status: "active",
      })
      .onConflictDoNothing();
  }

  private async registerSignals(
    entityId: string,
    signals: { type: string; value: string }[],
    source: string
  ): Promise<void> {
    // Delegate to the ONE signal write door (normalize + onConflictDoNothing).
    // onConflictDoNothing: if another entity already owns this signal, skip
    // silently (two contacts sharing an email, family accounts). A future
    // EntityMergeService can surface these as merge proposals.
    await registerIdentitySignals(this.db, entityId, signals, source);
  }
}

// ── Signal extraction helpers ───────────────────────────────────────────────

/**
 * Extract identity signals from a property map.
 * Import workers can call this to build the signals array automatically.
 *
 * Delegates the generic extraction (email/phone/url/handles) to the ONE
 * extractor `extractIdentitySignals`, then layers on the ONLY source-specific
 * addition this door owns: telegram's `telegramPhone` property.
 */
export function extractSignalsFromProperties(
  properties: Record<string, unknown>,
  source: string
): IdentitySignal[] {
  const signals = extractIdentitySignals(properties);

  // Telegram-specific: phone stored as telegramPhone property
  if (
    source === "telegram" &&
    typeof properties.telegramPhone === "string" &&
    properties.telegramPhone.length >= 7
  ) {
    signals.push({ type: "telegram_phone", value: properties.telegramPhone });
    // Also register as generic phone if no phone signal yet
    if (!signals.some((s) => s.type === "phone")) {
      signals.push({ type: "phone", value: properties.telegramPhone });
    }
  }

  return signals;
}
