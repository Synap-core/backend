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
import {
  extractIdentitySignals,
  registerIdentitySignals,
  resolveIdentity,
} from "../services/identity-resolution-service.js";
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
    // Cross-source identity resolution via the SSOT (IdentityResolutionService).
    // STRONG path only: extract the globally-unique atoms (email/phone/url/…)
    // from the entity's properties and look them up. No name/userScope is passed
    // so the scoped weak (name/handle) path never runs here — the materializer
    // input carries no visibility predicate, and auto-merging on a weak signal
    // would be wrong anyway. On a strong hit we ENRICH (mirror
    // EntityUpsertService): reuse the matched entity, register any new signals
    // against it, backfill project membership, and skip the insert.
    const signals = extractIdentitySignals(input.properties);
    if (signals.length > 0) {
      const resolution = await resolveIdentity(db, {
        userId: input.userId,
        signals,
      });
      if (resolution.match === "strong" && resolution.entity) {
        // Load the full row — the resolver returns a minimal projection.
        const existing = await db.query.entities.findFirst({
          where: eq(entities.id, resolution.entity.id),
        });
        if (existing) {
          // Enrich: register any signals this record carries that the matched
          // entity didn't already own (onConflictDoNothing — idempotent).
          await registerIdentitySignals(
            db,
            existing.id,
            signals,
            "materialize-entity"
          );
          // Idempotently backfill project membership on the reused row.
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
        // Signal owner points at a deleted/missing row — fall through to create.
      }
    }
    // No strong match (or no extractable signals) → plain create below. The new
    // row's signals are registered by EntityRepository.create (the one door).
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
 *
 * IDEMPOTENCY, NOT IDENTITY. This is the (user, kind, title) natural-key
 * de-dupe for repeat materializations of the SAME source item (e.g. a feed
 * bookmark re-seen) — it is deliberately NOT the identity resolver. The
 * strong-signal identity path (resolveIdentity) is wired alongside in the
 * materializer (W0); this title match stays as the exact-source idempotency
 * belt. Do not "upgrade" it into a fuzzy identity matcher — that's
 * IdentityResolutionService's job, and the single door for it.
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
