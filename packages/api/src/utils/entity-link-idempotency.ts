/**
 * Operation-keyed idempotency for composite materialization (U1).
 *
 * Makes entity materialization idempotent ON RETRY without merging distinct
 * same-named entities and without a DB transaction (the injected-caller
 * architecture blocks tx; idempotency keys are the fix).
 *
 * The key per created entity is `${namespace}:${op.ref}` where `namespace` is a
 * CLIENT-STABLE id supplied by the caller (an import proposalId / a capture
 * idempotencyKey). It is NEVER minted server-side per call (a retry would mint a
 * new one → not idempotent) and NEVER derived from the entity name/title/content
 * (two DISTINCT notes both named "Launch" would collide → wrong). Because two
 * distinct ops have different `op.ref` ("e0","e1"), they get different keys →
 * both create. A retry with the SAME namespace reproduces the SAME keys → links
 * to the already-created entities instead of re-creating them. This preserves
 * "same name = different entity".
 *
 * Storage reuses `entity_external_links` (provider, externalId) — the exact
 * dedup mechanism `EntityUpsertService` uses for re-imports. The lookup only
 * links to an entity when THIS (provider, externalId) row already exists, which
 * only happens if the same caller created it — so there is no cross-tenant link
 * risk.
 */

import {
  type db,
  eq,
  and,
  or,
  isNull,
  drizzleSql,
  entities,
  entityExternalLinks,
  relations,
  secrets,
  registerIdentitySignals,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "entity-link-idempotency" });

/** nangoConnectionId sentinel for non-OAuth imports (mirrors entity-upsert-service). */
const DIRECT_IMPORT_CONNECTION_ID = "direct-import";

export interface EntityLinkIdempotency {
  namespace: string;
  provider: string;
  lookup: (provider: string, externalId: string) => Promise<string | null>;
  register: (
    entityId: string,
    provider: string,
    externalId: string,
    /** Source-app url + producing connection (secrets row id) for a mirrored record. */
    link?: { url?: string | null; connectionId?: string | null }
  ) => Promise<void>;
  /**
   * Relation-retry idempotency: entities are keyed via external-links, but
   * relations have no external-link row, so a retry would re-create them. This
   * checks DB REALITY — true if a relation (sourceEntityId, targetEntityId,
   * type) already exists for this tenant. Checking reality (not inferring from
   * which entities were linked) is required: a crash AFTER pass-1 but BEFORE
   * pass-2 leaves entities-without-relations, and the retry must still create
   * the relations. Scoped by userId so the global relations table can't leak
   * cross-tenant. Only invoked when idempotency is active (keyed apply), so the
   * per-relation query cost is paid only by retry-safe imports/captures.
   */
  relationExists: (
    sourceEntityId: string,
    targetEntityId: string,
    type: string
  ) => Promise<boolean>;
  /**
   * Present only when the caller named the proposal its rows carry as lineage.
   * True when a retry's hit is a row THIS proposal created — a crash between
   * create and stamp — so the record can count it as the run's own creation.
   */
  ownsRetry?: (entityId: string) => Promise<boolean>;
  /** The relation edge's id when THIS proposal created it (same lineage rule). */
  ownedRelationId?: (
    sourceEntityId: string,
    targetEntityId: string,
    type: string
  ) => Promise<string | null>;
}

/**
 * Build the idempotency hooks for a materialization, keyed in
 * `entity_external_links` by (provider, externalId). `namespace` MUST be a
 * client-stable id (proposalId / capture idempotencyKey) so a retry reproduces
 * the same external ids and links instead of re-creating. `userId` scopes the
 * relation-existence check to the tenant.
 */
export function makeExternalLinkIdempotency(
  database: typeof db,
  {
    namespace,
    provider,
    userId,
    sourceProposalId,
  }: {
    namespace: string;
    provider: string;
    userId: string;
    /** The proposal the materialized rows carry as `source_proposal_id`. */
    sourceProposalId?: string;
  }
): EntityLinkIdempotency {
  return {
    namespace,
    provider,
    ...(sourceProposalId
      ? {
          ownsRetry: async (entityId: string) => {
            const [row] = await database
              .select({ id: entities.id })
              .from(entities)
              .where(
                and(
                  eq(entities.id, entityId),
                  eq(entities.sourceProposalId, sourceProposalId)
                )
              )
              .limit(1);
            return !!row;
          },
          ownedRelationId: async (
            sourceEntityId: string,
            targetEntityId: string,
            type: string
          ) => {
            const [row] = await database
              .select({ id: relations.id })
              .from(relations)
              .where(
                and(
                  eq(relations.userId, userId),
                  eq(relations.sourceEntityId, sourceEntityId),
                  eq(relations.targetEntityId, targetEntityId),
                  eq(relations.type, type),
                  eq(relations.sourceProposalId, sourceProposalId)
                )
              )
              .limit(1);
            return row?.id ?? null;
          },
        }
      : {}),
    // Exact (provider, externalId) match, restricted to a LIVE entity. A key
    // whose entity was soft-deleted (the run was reverted, then re-proposed and
    // re-applied) is not a retry: linking it would report the op as
    // materialized onto a deleted row and create nothing. It is a miss, so the
    // op creates afresh.
    //
    // Restricted to THIS user's copy: an external record can be shared (a
    // calendar event has one id on every attendee's calendar), so a link only
    // resolves onto an entity the user owns, or one a connection of theirs
    // produced (an import someone else approved).
    lookup: async (p, externalId) => {
      const [existing] = await database
        .select({ entityId: entityExternalLinks.entityId })
        .from(entityExternalLinks)
        .innerJoin(entities, eq(entities.id, entityExternalLinks.entityId))
        .where(
          and(
            eq(entityExternalLinks.provider, p),
            eq(entityExternalLinks.externalId, externalId),
            isNull(entities.deletedAt),
            or(
              eq(entities.userId, userId),
              drizzleSql`${entityExternalLinks.nangoConnectionId} in (select ${secrets.id}::text from ${secrets} where ${secrets.userId} = ${userId})`
            )
          )
        )
        // One row per connection can match: the user's own connection's row
        // first, then an unstamped import link.
        .orderBy(
          drizzleSql`case when ${entityExternalLinks.nangoConnectionId} in (select ${secrets.id}::text from ${secrets} where ${secrets.userId} = ${userId}) then 0 when ${entityExternalLinks.nangoConnectionId} = ${DIRECT_IMPORT_CONNECTION_ID} then 1 else 2 end`
        )
        .limit(1);
      return existing?.entityId ?? null;
    },
    // Mirrors entity-upsert-service.ts:178 — idempotent insert. A key held by a
    // LIVE entity is left alone (the DoNothing behaviour). A key still pointing
    // at a SOFT-DELETED entity is re-pointed at the fresh one — otherwise the
    // lookup above would miss on every later retry and each retry would create
    // another duplicate.
    register: async (entityId, p, externalId, link) => {
      // A mirrored record carries its source-app url and the connection that
      // produced it; an op-keyed idempotency key carries neither (sentinel).
      const linkFields = {
        ...(link?.url ? { url: link.url } : {}),
        nangoConnectionId: link?.connectionId ?? DIRECT_IMPORT_CONNECTION_ID,
      };
      await database
        .insert(entityExternalLinks)
        .values({
          entityId,
          provider: p,
          externalId,
          ...linkFields,
          status: "active",
        })
        .onConflictDoUpdate({
          target: [
            entityExternalLinks.provider,
            entityExternalLinks.externalId,
            entityExternalLinks.nangoConnectionId,
          ],
          set: { entityId, ...(link ? linkFields : {}) },
          setWhere: drizzleSql`exists (select 1 from ${entities} where ${entities.id} = ${entityExternalLinks.entityId} and ${entities.deletedAt} is not null)`,
        });
      // Also absorb the (provider, externalId) pair into the identity signal
      // layer — the dedup half of entity_external_links, so a later import
      // (or any other write door) resolving on the same external id lands on
      // this entity via resolveIdentity's strong path, not just this
      // idempotency lookup. signalValue has no uniqueness scoping issue: it's
      // already namespaced by provider, mirroring the external-links key.
      await registerIdentitySignals(
        database,
        entityId,
        [{ type: "external_id", value: `${p}:${externalId}` }],
        "import"
      ).catch((error) => {
        // Best-effort — the external-links row above is the source of truth
        // for import idempotency; a signal-write failure must never break it.
        // But it must not be silent: a lost signal degrades cross-source
        // matching, and nothing else reports it.
        logger.warn(
          { err: error, entityId, provider: p, externalId },
          "entity-link-idempotency: external_id identity-signal write failed — the external link exists but is invisible to resolveIdentity"
        );
      });
    },
    relationExists: async (sourceEntityId, targetEntityId, type) => {
      const existing = await database.query.relations.findFirst({
        where: and(
          eq(relations.userId, userId),
          eq(relations.sourceEntityId, sourceEntityId),
          eq(relations.targetEntityId, targetEntityId),
          eq(relations.type, type)
        ),
        columns: { id: true },
      });
      return Boolean(existing);
    },
  };
}
