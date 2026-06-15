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

import { db, eq, and, entityExternalLinks, relations } from "@synap/database";

/** nangoConnectionId sentinel for non-OAuth imports (mirrors entity-upsert-service). */
const DIRECT_IMPORT_CONNECTION_ID = "direct-import";

export interface EntityLinkIdempotency {
  namespace: string;
  provider: string;
  lookup: (provider: string, externalId: string) => Promise<string | null>;
  register: (
    entityId: string,
    provider: string,
    externalId: string
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
  }: { namespace: string; provider: string; userId: string }
): EntityLinkIdempotency {
  return {
    namespace,
    provider,
    // Mirrors entity-upsert-service.ts:102 — exact (provider, externalId) match.
    lookup: async (p, externalId) => {
      const existing = await database.query.entityExternalLinks.findFirst({
        where: and(
          eq(entityExternalLinks.provider, p),
          eq(entityExternalLinks.externalId, externalId)
        ),
        columns: { entityId: true },
      });
      return existing?.entityId ?? null;
    },
    // Mirrors entity-upsert-service.ts:178 — idempotent insert (onConflictDoNothing).
    register: async (entityId, p, externalId) => {
      await database
        .insert(entityExternalLinks)
        .values({
          entityId,
          provider: p,
          externalId,
          nangoConnectionId: DIRECT_IMPORT_CONNECTION_ID,
          status: "active",
        })
        .onConflictDoNothing();
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
