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
 *  3. No match → materializeEntity() (the governed single door; dedup already
 *     done by 1-2, so it is called with dedup:'none') + register all signals +
 *     external link
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
 *     provenance: { createdByKind: 'system' },
 *   });
 *   // result.action = 'created' | 'updated'
 */

import { eq, and } from "drizzle-orm";
import { entityExternalLinks, entities } from "../schema/index.js";
import type { getDb } from "../client-pg.js";
import type { Entity } from "../schema/entities.js";
import { FacetRepository } from "../repositories/facet-repository.js";
import type { EventRepository } from "../repositories/event-repository.js";
import {
  materializeEntity,
  type EntityProvenance,
} from "../utils/materialize-entity.js";
import { resolveRolePayload } from "./facet-resolution-service.js";
import { createLogger } from "@synap-core/core";
import {
  resolveIdentity,
  registerIdentitySignals,
  normalizeIdentitySignal,
  extractIdentitySignals,
  type IdentitySignal,
} from "./identity-resolution-service.js";

const logger = createLogger({ module: "entity-upsert-service" });

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
  /**
   * REQUIRED — who/what authored a row this upsert CREATES. Threaded straight
   * through to `materializeEntity` (invariant 4: no silent 'human' default).
   * Only consulted on the create path; a matched/updated row keeps the
   * provenance of whoever originally created it.
   */
  provenance: EntityProvenance;
  /**
   * When set, idempotently stamp `entity --belongs_to_project--> projectId`
   * on the created row (materializeEntity invariant 3).
   */
  projectId?: string | null;
}

export interface EntityUpsertResult {
  entity: Entity;
  /** 'created' = new entity. 'updated' = same externalId seen before. 'matched' = cross-source signal match. */
  action: "created" | "updated" | "matched";
}

/** nangoConnectionId sentinel for non-OAuth imports */
const DIRECT_IMPORT_CONNECTION_ID = "direct-import";

/**
 * The drizzle db handle — the SAME shape `materializeEntity` requires (and that
 * both construction sites already pass, via `await getDb()`). Previously typed
 * as the narrower `PostgresJsDatabase<typeof schema>`, which omitted `$client`
 * and so could not be forwarded to the materializer.
 */
type UpsertDb = Awaited<ReturnType<typeof getDb>>;

export class EntityUpsertService {
  private facetRepo: FacetRepository;

  private eventRepo: EventRepository;

  constructor(
    private db: UpsertDb,
    eventRepo: EventRepository
  ) {
    this.eventRepo = eventRepo;
    this.facetRepo = new FacetRepository(db, eventRepo);
  }

  /**
   * Kind + Facets: attach a role onto an entity as an import-time facet.
   * `applicableKinds` is validated by the caller (it already resolved the role);
   * here we skipValidation to tolerate messy import property values (attach
   * type-checks otherwise, and imports run with skipValidation on creates too).
   * Best-effort — a facet failure never sinks the upsert result.
   */
  private async attachRole(
    entityId: string,
    roleProfileId: string,
    properties: Record<string, unknown>,
    workspaceId: string | null,
    userId: string
  ): Promise<void> {
    try {
      await this.facetRepo.attach(
        {
          entityId,
          profileId: roleProfileId,
          userId,
          workspaceId,
          properties,
          skipValidation: true,
        },
        userId
      );
    } catch (err) {
      logger.warn(
        { err, entityId, roleProfileId },
        "EntityUpsertService: role facet attach failed (entity preserved)"
      );
    }
  }

  /** Attach a role to a matched entity, gated on the role's applicableKinds. */
  private async attachRoleOnMatch(
    entity: Entity,
    rolePayload: NonNullable<Awaited<ReturnType<typeof resolveRolePayload>>>,
    input: EntityUpsertInput
  ): Promise<void> {
    const kind = entity.type ?? undefined;
    if (
      rolePayload.applicableKinds.length > 0 &&
      (!kind || !rolePayload.applicableKinds.includes(kind))
    ) {
      logger.warn(
        { entityId: entity.id, role: rolePayload.slug, kind },
        "EntityUpsertService: role does not apply to matched entity's kind — skipping attach"
      );
      return;
    }
    await this.attachRole(
      entity.id,
      rolePayload.profileId,
      input.properties,
      input.workspaceId,
      input.userId
    );
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

    // Kind + Facets guard: a role-profile slug (client/partner/…) must never
    // become a role-named entity — the role is a facet on a real subject.
    // Resolved up front so a strong match (below) attaches the role to the
    // matched entity instead of dropping it.
    const rolePayload = await resolveRolePayload(this.db, input.profileSlug);

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
        // Kind + Facets: a role payload attaches onto the matched subject.
        if (rolePayload)
          await this.attachRoleOnMatch(entity as Entity, rolePayload, input);
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
          // Kind + Facets: a role payload attaches onto the matched subject.
          if (rolePayload)
            await this.attachRoleOnMatch(entity as Entity, rolePayload, input);
          return { entity: entity as Entity, action: "matched" };
        }
      }
    }

    // ── Step 3: Create new entity ─────────────────────────────────────────────
    // Kind + Facets: no identity match for a role-slug payload. Create the
    // entity of the role's applicable KIND (only when it's unambiguous — a
    // single applicableKind) and attach the role as a facet, so we never
    // materialize a role-named entity. When the kind is ambiguous/underivable,
    // fall back to current behavior + log — never invent an identity/kind.
    let createSlug = input.profileSlug;
    if (rolePayload && rolePayload.applicableKinds.length === 1) {
      createSlug = rolePayload.applicableKinds[0];
    } else if (rolePayload) {
      logger.warn(
        {
          role: rolePayload.slug,
          applicableKinds: rolePayload.applicableKinds,
        },
        "EntityUpsertService: role-slug payload has no single applicable kind and no identity match — creating as-is (fallback)"
      );
    }

    // Funnel through the governed materializer (NOT EntityRepository.create
    // directly) so this path gets the cross-cutting invariants: relation-slug
    // guard, project-link, required provenance, completeness.
    //
    // dedup: 'none' is deliberate and load-bearing — identity resolution is
    // ALREADY DONE by Steps 1-2 above (external-link exact match, then the
    // strong-signal resolver). Asking the materializer to dedup again would
    // re-run resolveIdentity against signals it would re-extract from
    // properties — a redundant query at best, and a second, differently-scoped
    // matching policy at worst. By here, "no match" is settled: create.
    const { entity } = await materializeEntity(
      {
        profileSlug: createSlug,
        title: input.title,
        properties: input.properties,
        workspaceId: input.workspaceId,
        userId: input.userId,
        // Imports stay permissive for their existing kinds, but Knowledge has
        // one canonical form and must enter through the normalizer/validator.
        // This keeps malformed or conflicting legacy+canonical values from
        // becoming durable data through capture's materialized-upsert path.
        skipValidation: createSlug !== "knowledge",
      },
      {
        db: this.db,
        eventRepo: this.eventRepo,
        provenance: input.provenance,
        dedup: "none",
        projectId: input.projectId,
      }
    );

    await Promise.all([
      this.registerExternalLink(entity.id, input.source, input.externalId),
      this.registerSignals(entity.id, normalizedSignals, input.source),
    ]);

    // Attach the role as a facet onto the freshly-created kind entity (only when
    // we rewrote the slug to a derived kind — the fallback path kept the role
    // slug as the entity's own kind, so there's no separate role to attach).
    if (rolePayload && createSlug !== input.profileSlug) {
      await this.attachRole(
        entity.id,
        rolePayload.profileId,
        input.properties,
        input.workspaceId,
        input.userId
      );
    }

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
