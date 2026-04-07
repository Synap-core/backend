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

import { eq, and, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  entityExternalLinks,
  entityIdentitySignals,
  entities,
} from "../schema/index.js";
import type { Entity } from "../schema/entities.js";
import { EntityRepository } from "../repositories/entity-repository.js";
import type { EventRepository } from "../repositories/event-repository.js";
import type { IdentitySignalType } from "../schema/entity-identity-signals.js";

export interface IdentitySignal {
  type: IdentitySignalType;
  value: string;
}

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
  workspaceId: string;
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
    private db: PostgresJsDatabase<typeof import("../schema/index.js")>,
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
      value: normalizeSignalValue(s.type, s.value),
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

    // ── Step 2: Cross-source signal match ──────────────────────────────────────
    if (normalizedSignals.length > 0) {
      const signalMatch = await this.db.query.entityIdentitySignals.findFirst({
        where: or(
          ...normalizedSignals.map((s) =>
            and(
              eq(entityIdentitySignals.signalType, s.type),
              eq(entityIdentitySignals.signalValue, s.value)
            )
          )
        ),
        columns: { entityId: true },
      });

      if (signalMatch) {
        const entity = await this.db.query.entities.findFirst({
          where: eq(entities.id, signalMatch.entityId),
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
    if (signals.length === 0) return;

    const rows = signals.map((s) => ({
      entityId,
      signalType: s.type,
      signalValue: s.value,
      source,
    }));

    // onConflictDoNothing: if another entity already owns this signal, skip silently.
    // This can happen if two contacts share an email address (aliases, family accounts).
    // A future EntityMergeService can surface these as merge proposals.
    await this.db
      .insert(entityIdentitySignals)
      .values(rows)
      .onConflictDoNothing();
  }
}

// ── Signal normalization ────────────────────────────────────────────────────

function normalizeSignalValue(type: string, value: string): string {
  const v = value.trim();
  switch (type) {
    case "email":
      return v.toLowerCase();

    case "phone":
    case "telegram_phone": {
      // Keep the + prefix, strip everything else (spaces, dashes, parens, dots)
      const digits = v.replace(/[^\d+]/g, "").replace(/^\+?/, "+");
      // Remove any duplicate leading +
      return digits.startsWith("++") ? digits.slice(1) : digits;
    }

    case "linkedin_url":
      return v.toLowerCase().replace(/\/$/, "");

    case "github_username":
    case "twitter_handle":
      return v.toLowerCase().replace(/^@/, "");

    case "website":
      return v.toLowerCase().replace(/\/$/, "");

    default:
      return v.toLowerCase();
  }
}

// ── Signal extraction helpers ───────────────────────────────────────────────

/**
 * Extract identity signals from a property map.
 * Import workers can call this to build the signals array automatically.
 */
export function extractSignalsFromProperties(
  properties: Record<string, unknown>,
  source: string
): IdentitySignal[] {
  const signals: IdentitySignal[] = [];

  if (typeof properties.email === "string" && properties.email.includes("@")) {
    signals.push({ type: "email", value: properties.email });
  }

  if (typeof properties.phone === "string" && properties.phone.length >= 7) {
    signals.push({ type: "phone", value: properties.phone });
  }

  if (
    typeof properties.linkedinUrl === "string" &&
    properties.linkedinUrl.includes("linkedin.com")
  ) {
    signals.push({ type: "linkedin_url", value: properties.linkedinUrl });
  }

  if (
    typeof properties.githubUsername === "string" &&
    properties.githubUsername.length > 0
  ) {
    signals.push({ type: "github_username", value: properties.githubUsername });
  }

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
