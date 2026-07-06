/**
 * Governed Entity Materializer — the keystone single door for creating an
 * entity row with all of its cross-cutting invariants applied IN ORDER.
 *
 * `materializeEntity()` wraps the canonical `EntityRepository.create` and owns
 * the five invariants that were previously scattered (or silently skipped) at
 * every raw-insert / bespoke-create site:
 *
 *   1. relation-slug guard — refuse an entity whose title/type EXACTLY equals a
 *      known relation slug (a misclassified edge-type). Typed skip, never a
 *      silent junk row.
 *   2. dedup            — per-type policy hook: 'none' (default), 'natural-key'
 *      (reuse existing user+type+title row), 'identity-signal' (cross-source
 *      resolution — see TODO below).
 *   3. project-link     — idempotent `belongs_to_project` edge when a projectId
 *      is supplied (stops every caller from re-implementing this).
 *   4. provenance       — REQUIRED. No silent 'human' default — the caller MUST
 *      state who/what authored the row (human / ai_agent / system).
 *   5. completeness     — one insert, return the row.
 *
 * Framework-free (pure @synap/database — no @synap/api imports) so pg-boss jobs
 * workers can import it directly. The GOVERNANCE gate (RBAC / propose-or-write)
 * stays at the API router / worker BEFORE this is called; this module only owns
 * the write-shape invariants, not the permission decision.
 */

import { and, eq } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import { entities } from "../schema/entities.js";
import type { Entity } from "../schema/entities.js";
import type { getDb } from "../client-pg.js";
import { EntityRepository } from "../repositories/entity-repository.js";
import type { EventRepository } from "../repositories/event-repository.js";
import { DEFAULT_RELATION_DEFS } from "./default-relation-defs.js";
import { linkEntityToProject } from "./entity-project-membership.js";

const logger = createLogger({ module: "materialize-entity" });

/** The drizzle db (or transaction) handle — same shape callers already hold. */
type MaterializerDb = Awaited<ReturnType<typeof getDb>>;

/**
 * Known built-in relation slugs (lowercased), O(1) lookup. THE single source of
 * truth for the relation-slug collision guard, shared by this materializer
 * (invariant 1) and by the API's composite materializer (which imports this set
 * instead of rebuilding its own). Static set (no per-create DB query); custom
 * user-defined relation collisions are out of scope.
 */
export const RELATION_SLUGS: ReadonlySet<string> = new Set(
  DEFAULT_RELATION_DEFS.map((d) => d.slug.toLowerCase())
);

export type EntityProvenanceKind = "human" | "ai_agent" | "system";

/**
 * Who/what authored this row. REQUIRED at every materialize call — a caller
 * must state its provenance rather than inheriting a silent 'human' default.
 */
export interface EntityProvenance {
  createdByKind: EntityProvenanceKind;
  createdByUserId?: string;
  agentUserId?: string;
  sourceProposalId?: string;
}

/**
 * Dedup policy (per-type hook):
 *  - 'none'            — always create (default).
 *  - 'natural-key'     — reuse an existing row matching user + type + title.
 *  - 'identity-signal' — cross-source identity resolution (EntityUpsertService).
 *                        NOT yet wired here (needs source/externalId/signals the
 *                        materializer input does not carry) — see TODO below.
 */
export type EntityDedupPolicy = "none" | "natural-key" | "identity-signal";

export interface MaterializeEntityInput {
  /** Pin the row id (proposal materializer parity). Omit for a DB-minted uuid. */
  id?: string;
  profileId?: string;
  profileSlug?: string;
  title?: string;
  preview?: string;
  documentId?: string;
  properties?: Record<string, unknown>;
  /** null = pod-wide. The router/worker resolves the effective scope. */
  workspaceId?: string | null;
  userId: string;
  /** Store properties as-is (trusted seed data) — skips schema enforcement. */
  skipValidation?: boolean;
}

export interface MaterializeEntityOptions {
  db: MaterializerDb;
  eventRepo: EventRepository;
  /** REQUIRED — no silent 'human' default. A caller MUST state its provenance. */
  provenance: EntityProvenance;
  /** Dedup policy. Defaults to 'none'. */
  dedup?: EntityDedupPolicy;
  /** When set, idempotently stamp `entity --belongs_to_project--> projectId`. */
  projectId?: string | null;
}

export interface MaterializeEntityOutcome {
  entity: Entity;
  /** true when dedup matched an existing row (no insert happened). */
  reused: boolean;
}

/**
 * Typed skip raised by invariant 1: the entity's title/type EXACTLY collides
 * with a known relation slug (likely a misclassified edge-type). Callers that
 * batch may catch + skip; single-write callers surface it.
 */
export class RelationSlugEntityError extends Error {
  constructor(public readonly collision: string) {
    super(
      `Entity title/type "${collision}" collides with a known relation slug — refusing to materialize (likely a misclassified edge-type).`
    );
    this.name = "RelationSlugEntityError";
  }
}

export async function materializeEntity(
  input: MaterializeEntityInput,
  opts: MaterializeEntityOptions
): Promise<MaterializeEntityOutcome> {
  const { db, eventRepo, provenance, dedup = "none", projectId } = opts;

  // ── Invariant 1: relation-slug guard ─────────────────────────────────────
  const titleKey = input.title?.trim().toLowerCase();
  const slugKey = input.profileSlug?.trim().toLowerCase();
  const collision =
    (titleKey && RELATION_SLUGS.has(titleKey) && titleKey) ||
    (slugKey && RELATION_SLUGS.has(slugKey) && slugKey) ||
    undefined;
  if (collision) {
    logger.warn(
      {
        title: input.title,
        profileSlug: input.profileSlug,
        createdByKind: provenance.createdByKind,
      },
      "Refusing to materialize entity: title/type collides with a known relation slug"
    );
    throw new RelationSlugEntityError(collision);
  }

  const entityRepo = new EntityRepository(db, eventRepo);

  // ── Invariant 2: dedup ───────────────────────────────────────────────────
  if (dedup === "natural-key") {
    const existing = await findByNaturalKey(db, input);
    if (existing) {
      // Reuse: no insert. Still (idempotently) stamp project membership so a
      // re-run BACKFILLS the edge on a pre-existing row (invariant 3).
      if (projectId) {
        await linkEntityToProject(db, {
          entityId: existing.id,
          projectId,
          userId: input.userId,
          workspaceId: input.workspaceId ?? null,
        });
      }
      return { entity: existing, reused: true };
    }
  } else if (dedup === "identity-signal") {
    // TODO(wave-1): identity-signal dedup requires source/externalId/signals
    // that MaterializeEntityInput does not carry. Wire EntityUpsertService when
    // a caller needs it; for now we log and fall through to a plain create (no
    // cross-source resolution) rather than block Wave 1.
    logger.warn(
      { profileSlug: input.profileSlug },
      "dedup:'identity-signal' is not yet wired in materializeEntity — falling back to a plain create (no cross-source identity resolution)"
    );
  }

  // ── Invariant 4: provenance (passed into the canonical create) ───────────
  const entity = await entityRepo.create(
    {
      id: input.id,
      profileId: input.profileId,
      profileSlug: input.profileSlug,
      title: input.title,
      preview: input.preview,
      documentId: input.documentId,
      properties: input.properties,
      workspaceId: input.workspaceId,
      userId: input.userId,
      skipValidation: input.skipValidation,
      createdByKind: provenance.createdByKind,
      createdByUserId: provenance.createdByUserId,
      agentUserId: provenance.agentUserId,
      sourceProposalId: provenance.sourceProposalId,
    },
    input.userId
  );

  // ── Invariant 3: project-link (idempotent) ───────────────────────────────
  if (projectId) {
    await linkEntityToProject(db, {
      entityId: entity.id,
      projectId,
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
    });
  }

  // ── Invariant 5: completeness — one insert, return the row ───────────────
  return { entity, reused: false };
}

/**
 * Natural key = user + type + title. `entities.type` stores the profile slug,
 * so when the caller passes `profileSlug` we match on it directly. (No funnel
 * site uses profileId + natural-key; that combination skips dedup and creates.)
 */
async function findByNaturalKey(
  db: MaterializerDb,
  input: MaterializeEntityInput
): Promise<Entity | undefined> {
  if (!input.title || !input.profileSlug) return undefined;
  const existing = await db.query.entities.findFirst({
    where: and(
      eq(entities.userId, input.userId),
      eq(entities.type, input.profileSlug),
      eq(entities.title, input.title)
    ),
  });
  return existing;
}
