/**
 * EntityMergeService — Pod Hygiene W0
 *
 * ONE door for merging two entity instances that represent the same real-world
 * subject, and for full unmerge via invertibility stamps. Caller/approve path
 * owns side-effect emission (Typesense, vectors, realtime, automations) — this
 * service only mutates the data plane.
 *
 * Locked product decisions (W0):
 *  - same profile/kind only (`entities.type` must match)
 *  - same workspace OR both pod-wide (workspaceId null); NO cross-workspace
 *  - property policy: fill-null only; collect conflicts, never silent overwrite
 *  - documents: move only when winner has none and loser has one
 *  - loser: soft-delete + systemData.mergedInto = winnerId
 *  - facets re-homed via FacetRepository; attach-failure → detach-on-conflict
 *    when winner already has equivalent live facet, else leave on loser
 *  - facets on OTHER entities with contextEntityId=loserId re-pointed to winner
 *  - signals/relations/links re-pointed
 *  - NEVER hard-delete the loser entity
 *  - unmerge: reverse stamp + restore snapshots; deletedRelationIds irreversible
 */

import { eq, and, or, isNull, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createLogger } from "@synap-core/core";
import {
  entities,
  entityIdentitySignals,
  entityExternalLinks,
  entityFacets,
  relations,
  links,
  messageLinks,
} from "../schema/index.js";
import type * as schema from "../schema/index.js";
import type { Entity } from "../schema/entities.js";
import { FacetRepository } from "../repositories/facet-repository.js";
import type { EventRepository } from "../repositories/event-repository.js";

const logger = createLogger({ module: "entity-merge-service" });

type Db = PostgresJsDatabase<typeof schema>;

// ── Public types ─────────────────────────────────────────────────────────────

export interface PropertyConflict {
  key: string;
  winnerValue: unknown;
  loserValue: unknown;
}

export interface EntityMergePlan {
  winnerId: string;
  loserId: string;
  /** fill-null property keys taken from loser */
  filledProperties: string[];
  /** both had values that differ */
  conflicts: PropertyConflict[];
  documentAction: "moved" | "kept_both" | "none";
}

/** Pre-merge snapshot of entity projection fields (unmerge restore source). */
export interface EntityMergeFieldSnapshot {
  title: string | null;
  preview: string | null;
  properties: Record<string, unknown>;
  documentId: string | null;
  systemData: Record<string, unknown>;
  version: number;
}

/**
 * Invertibility stamp produced by mergeEntities and consumed by unmergeEntities.
 * Stored on `proposals.data.materialized.merge` by the approve executor.
 */
export interface MergeMaterializedStamp {
  /** Winner signal row ids that were created from loser signals. */
  movedSignalIds: string[];
  /** External-link row ids re-pointed loser → winner. */
  movedExternalLinkIds: string[];
  /** Soft-detached loser facet ids (restored on unmerge). */
  movedFacetIds: string[];
  /** Facet ids created/attached on winner during merge (detached on unmerge). */
  winnerFacetIds?: string[];
  /**
   * Relations re-pointed loser → winner, with prior endpoints for exact reverse.
   * Replaces bare `rewiredRelationIds` (kept optional on the proposal type for
   * legacy stamps that only recorded ids).
   */
  rewiredRelations: Array<{
    id: string;
    previousSourceEntityId: string | null;
    previousTargetEntityId: string | null;
  }>;
  /** message_links rows re-pointed loser → winner. */
  rewiredMessageLinkIds?: string[];
  /** Polymorphic links re-pointed loser → winner. */
  rewiredLinkIds?: string[];
  documentMoved: boolean;
  /**
   * Relations dropped as self-loop / dedupe — irreversible; audit only.
   */
  deletedRelationIds?: string[];
}

export interface EntityMergeResult {
  winnerId: string;
  loserId: string;
  plan: EntityMergePlan;
  previousWinnerSnapshot: EntityMergeFieldSnapshot;
  previousLoserSnapshot: EntityMergeFieldSnapshot;
  materialized: MergeMaterializedStamp;
}

export interface MergeEntityInput {
  winnerId: string;
  loserId: string;
  userId: string;
  /**
   * Optional event repo for FacetRepository attach/detach domain events.
   * When omitted, facet mutations use a silent no-op event repo so this
   * service stays side-effect-free at the search/automation layer. Callers
   * that want facet domain events on the event stream pass a real repo.
   */
  eventRepo?: EventRepository;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** True when a property value is considered "missing" for fill-null policy. */
export function isEmptyPropertyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

/**
 * Fill-null property union.
 * - Winner keeps non-empty values.
 * - Loser fills only when winner is missing/null/empty string.
 * - When both have different non-empty values → conflict (winner keeps its value).
 */
export function buildPropertyUnion(
  winnerProps: Record<string, unknown>,
  loserProps: Record<string, unknown>
): {
  merged: Record<string, unknown>;
  filled: string[];
  conflicts: PropertyConflict[];
} {
  const merged: Record<string, unknown> = { ...winnerProps };
  const filled: string[] = [];
  const conflicts: PropertyConflict[] = [];

  for (const [key, loserValue] of Object.entries(loserProps)) {
    if (isEmptyPropertyValue(loserValue)) continue;

    const winnerValue = winnerProps[key];
    if (isEmptyPropertyValue(winnerValue)) {
      merged[key] = loserValue;
      filled.push(key);
      continue;
    }

    // Both non-empty — conflict if they differ (deep-ish JSON compare).
    if (!propertyValuesEqual(winnerValue, loserValue)) {
      conflicts.push({ key, winnerValue, loserValue });
    }
  }

  return { merged, filled, conflicts };
}

function propertyValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null
  ) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

export interface MergeCandidate {
  id: string;
  createdAt: Date;
  properties: Record<string, unknown>;
  title: string | null;
}

/**
 * Prefer: more non-empty properties, then older createdAt, then stable id order.
 */
export function pickMergeWinner(
  a: MergeCandidate,
  b: MergeCandidate
): { winnerId: string; loserId: string; reason: string } {
  const aCount = countNonEmptyProperties(a.properties);
  const bCount = countNonEmptyProperties(b.properties);

  if (aCount !== bCount) {
    const aWins = aCount > bCount;
    return {
      winnerId: aWins ? a.id : b.id,
      loserId: aWins ? b.id : a.id,
      reason: `more_non_empty_properties (${aWins ? aCount : bCount} > ${aWins ? bCount : aCount})`,
    };
  }

  const aTime = a.createdAt.getTime();
  const bTime = b.createdAt.getTime();
  if (aTime !== bTime) {
    const aWins = aTime < bTime;
    return {
      winnerId: aWins ? a.id : b.id,
      loserId: aWins ? b.id : a.id,
      reason: "older_created_at",
    };
  }

  // Stable id order (lexicographic UUID string compare).
  const aWins = a.id < b.id;
  return {
    winnerId: aWins ? a.id : b.id,
    loserId: aWins ? b.id : a.id,
    reason: "stable_id_order",
  };
}

export function countNonEmptyProperties(
  properties: Record<string, unknown>
): number {
  let n = 0;
  for (const value of Object.values(properties)) {
    if (!isEmptyPropertyValue(value)) n += 1;
  }
  return n;
}

export function planDocumentAction(
  winnerDocumentId: string | null,
  loserDocumentId: string | null
): "moved" | "kept_both" | "none" {
  if (!winnerDocumentId && loserDocumentId) return "moved";
  if (winnerDocumentId && loserDocumentId) return "kept_both";
  return "none";
}

/**
 * Validate two loaded entities can be merged. Throws Error with a clear message.
 * Pure — no DB access.
 */
export function assertMergeablePair(
  winner: Entity,
  loser: Entity,
  userId: string
): void {
  if (winner.id === loser.id) {
    throw new Error("Cannot merge an entity with itself");
  }
  if (winner.deletedAt) {
    throw new Error(`Winner entity ${winner.id} is soft-deleted`);
  }
  if (loser.deletedAt) {
    throw new Error(`Loser entity ${loser.id} is soft-deleted`);
  }
  if (winner.type !== loser.type) {
    throw new Error(
      `Cannot merge different kinds: winner.type=${winner.type} loser.type=${loser.type}`
    );
  }
  if (winner.userId !== loser.userId) {
    throw new Error(
      `Cannot merge entities owned by different users: winner.userId=${winner.userId} loser.userId=${loser.userId}`
    );
  }
  if (winner.userId !== userId || loser.userId !== userId) {
    throw new Error(
      `Merge userId ${userId} does not match entity owners (winner=${winner.userId}, loser=${loser.userId})`
    );
  }
  // Workspace: same workspace OR both pod-wide (null). NO cross-workspace.
  const wWs = winner.workspaceId ?? null;
  const lWs = loser.workspaceId ?? null;
  if (wWs !== lWs) {
    throw new Error(
      `Cannot merge across workspaces: winner.workspaceId=${wWs} loser.workspaceId=${lWs}`
    );
  }
}

// ── Merge door ───────────────────────────────────────────────────────────────

/**
 * Merge loser into winner. Atomic data-plane mutation. Does NOT emit search/
 * embedding/automation side-effects — the approve path is responsible.
 */
export async function mergeEntities(
  db: Db,
  input: MergeEntityInput
): Promise<EntityMergeResult> {
  const { winnerId, loserId, userId } = input;

  if (winnerId === loserId) {
    throw new Error("Cannot merge an entity with itself");
  }

  const [winner, loser] = await Promise.all([
    db.query.entities.findFirst({ where: eq(entities.id, winnerId) }),
    db.query.entities.findFirst({ where: eq(entities.id, loserId) }),
  ]);

  if (!winner) {
    throw new Error(`Winner entity ${winnerId} not found`);
  }
  if (!loser) {
    throw new Error(`Loser entity ${loserId} not found`);
  }

  assertMergeablePair(winner, loser, userId);

  const winnerProps = (winner.properties ?? {}) as Record<string, unknown>;
  const loserProps = (loser.properties ?? {}) as Record<string, unknown>;
  const { merged, filled, conflicts } = buildPropertyUnion(
    winnerProps,
    loserProps
  );
  const documentAction = planDocumentAction(
    winner.documentId,
    loser.documentId
  );

  const plan: EntityMergePlan = {
    winnerId,
    loserId,
    filledProperties: filled,
    conflicts,
    documentAction,
  };

  const previousWinnerSnapshot: EntityMergeFieldSnapshot = {
    title: winner.title,
    preview: winner.preview,
    properties: { ...winnerProps },
    documentId: winner.documentId,
    systemData: {
      ...((winner.systemData ?? {}) as Record<string, unknown>),
    },
    version: winner.version,
  };

  const previousLoserSnapshot: EntityMergeFieldSnapshot = {
    title: loser.title,
    preview: loser.preview,
    properties: { ...loserProps },
    documentId: loser.documentId,
    systemData: {
      ...((loser.systemData ?? {}) as Record<string, unknown>),
    },
    version: loser.version,
  };

  const documentMoved = documentAction === "moved";
  const nextDocumentId = documentMoved ? loser.documentId : winner.documentId;

  // Fill empty title/preview from loser (display metadata, not in filledProperties).
  const nextTitle =
    winner.title && winner.title.trim() !== ""
      ? winner.title
      : loser.title && loser.title.trim() !== ""
        ? loser.title
        : winner.title;
  const nextPreview =
    winner.preview && winner.preview.trim() !== ""
      ? winner.preview
      : loser.preview && loser.preview.trim() !== ""
        ? loser.preview
        : winner.preview;

  const silentEventRepo = createSilentEventRepo();
  const eventRepo = input.eventRepo ?? silentEventRepo;

  const materialized = await db.transaction(async (tx) => {
    const movedSignalIds: string[] = [];
    const rewiredRelations: MergeMaterializedStamp["rewiredRelations"] = [];
    const movedFacetIds: string[] = [];
    const winnerFacetIds: string[] = [];
    const movedExternalLinkIds: string[] = [];
    const rewiredMessageLinkIds: string[] = [];
    const rewiredLinkIds: string[] = [];
    const deletedRelationIds: string[] = [];

    // 1. Update winner projection.
    await tx
      .update(entities)
      .set({
        title: nextTitle,
        preview: nextPreview,
        properties: merged,
        documentId: nextDocumentId,
        version: winner.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(entities.id, winnerId));

    // 2. Signals: delete from loser, insert on winner (onConflict skip).
    const loserSignals = await tx
      .select()
      .from(entityIdentitySignals)
      .where(eq(entityIdentitySignals.entityId, loserId));

    for (const signal of loserSignals) {
      await tx
        .delete(entityIdentitySignals)
        .where(eq(entityIdentitySignals.id, signal.id));

      const inserted = await tx
        .insert(entityIdentitySignals)
        .values({
          entityId: winnerId,
          signalType: signal.signalType,
          signalValue: signal.signalValue,
          source: signal.source,
        })
        .onConflictDoNothing()
        .returning({ id: entityIdentitySignals.id });

      if (inserted.length > 0) {
        movedSignalIds.push(inserted[0]!.id);
      } else {
        // Winner already owned (type, value) — rare race; signal discarded.
        logger.info(
          {
            signalType: signal.signalType,
            signalValue: signal.signalValue,
            winnerId,
            loserId,
          },
          "entity-merge: signal already on winner, skipped insert"
        );
      }
    }

    // 3. External links: re-point entityId → winner.
    // Unique is (provider, externalId) — loser owns its rows exclusively so a
    // simple update is correct. onConflictDoNothing is insert-only; for safety
    // we update row-by-row and skip on unique violation by deleting loser row.
    const loserExtLinks = await tx
      .select()
      .from(entityExternalLinks)
      .where(eq(entityExternalLinks.entityId, loserId));

    for (const link of loserExtLinks) {
      try {
        await tx
          .update(entityExternalLinks)
          .set({ entityId: winnerId })
          .where(eq(entityExternalLinks.id, link.id));
        movedExternalLinkIds.push(link.id);
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Winner already has this provider+externalId — drop loser's row.
          await tx
            .delete(entityExternalLinks)
            .where(eq(entityExternalLinks.id, link.id));
          logger.info(
            { linkId: link.id, provider: link.provider, winnerId, loserId },
            "entity-merge: external link already on winner, dropped loser row"
          );
        } else {
          throw err;
        }
      }
    }

    // 4. Relations: re-point source/target; drop self-loops; skip identical edges.
    // Stamp previous endpoints so unmerge can reverse exactly.
    const loserRelations = await tx
      .select()
      .from(relations)
      .where(
        or(
          eq(relations.sourceEntityId, loserId),
          eq(relations.targetEntityId, loserId)
        )
      );

    for (const rel of loserRelations) {
      const previousSourceEntityId = rel.sourceEntityId;
      const previousTargetEntityId = rel.targetEntityId;
      const newSource =
        rel.sourceEntityId === loserId ? winnerId : rel.sourceEntityId;
      const newTarget =
        rel.targetEntityId === loserId ? winnerId : rel.targetEntityId;

      // Self-loop after rewire (entity↔entity only).
      const sourceIsEntity = (rel.sourceKind ?? "entity") === "entity";
      const targetIsEntity = (rel.targetKind ?? "entity") === "entity";
      if (
        sourceIsEntity &&
        targetIsEntity &&
        newSource &&
        newTarget &&
        newSource === newTarget
      ) {
        await tx.delete(relations).where(eq(relations.id, rel.id));
        deletedRelationIds.push(rel.id);
        continue;
      }

      // Identical edge already exists on winner → drop this one (dedupe).
      if (newSource && newTarget) {
        const [existing] = await tx
          .select({ id: relations.id })
          .from(relations)
          .where(
            and(
              eq(relations.sourceEntityId, newSource),
              eq(relations.targetEntityId, newTarget),
              eq(relations.type, rel.type),
              ne(relations.id, rel.id)
            )
          )
          .limit(1);
        if (existing) {
          await tx.delete(relations).where(eq(relations.id, rel.id));
          deletedRelationIds.push(rel.id);
          continue;
        }
      }

      await tx
        .update(relations)
        .set({
          sourceEntityId: newSource,
          targetEntityId: newTarget,
        })
        .where(eq(relations.id, rel.id));
      rewiredRelations.push({
        id: rel.id,
        previousSourceEntityId,
        previousTargetEntityId,
      });
    }

    // 5. Polymorphic links: re-point entity endpoints (single pass).
    const loserLinks = await tx
      .select()
      .from(links)
      .where(
        or(
          and(eq(links.fromType, "entity"), eq(links.fromId, loserId)),
          and(eq(links.toType, "entity"), eq(links.toId, loserId))
        )
      );

    for (const edge of loserLinks) {
      const newFromId =
        edge.fromType === "entity" && edge.fromId === loserId
          ? winnerId
          : edge.fromId;
      const newToId =
        edge.toType === "entity" && edge.toId === loserId
          ? winnerId
          : edge.toId;

      // Entity↔entity self-loop after rewire → drop.
      if (
        edge.fromType === "entity" &&
        edge.toType === "entity" &&
        newFromId === newToId
      ) {
        await tx.delete(links).where(eq(links.id, edge.id));
        continue;
      }

      // Identical edge already exists → drop this one.
      const [existingLink] = await tx
        .select({ id: links.id })
        .from(links)
        .where(
          and(
            eq(links.fromType, edge.fromType),
            eq(links.fromId, newFromId),
            eq(links.toType, edge.toType),
            eq(links.toId, newToId),
            eq(links.linkType, edge.linkType),
            ne(links.id, edge.id)
          )
        )
        .limit(1);
      if (existingLink) {
        await tx.delete(links).where(eq(links.id, edge.id));
        continue;
      }

      try {
        await tx
          .update(links)
          .set({ fromId: newFromId, toId: newToId })
          .where(eq(links.id, edge.id));
        rewiredLinkIds.push(edge.id);
      } catch (err) {
        if (isUniqueViolation(err)) {
          await tx.delete(links).where(eq(links.id, edge.id));
        } else {
          throw err;
        }
      }
    }

    // 6. message_links: re-point entity targets; collect returning ids.
    const rewiredMsgLinks = await tx
      .update(messageLinks)
      .set({ targetId: winnerId })
      .where(
        and(
          eq(messageLinks.targetType, "entity"),
          eq(messageLinks.targetId, loserId)
        )
      )
      .returning({ id: messageLinks.id });
    for (const row of rewiredMsgLinks) {
      rewiredMessageLinkIds.push(row.id);
    }

    // 7. Facets: re-home via FacetRepository (attach to winner, detach on loser).
    // On attach failure: if winner already has an equivalent live facet
    // (same profileId + contextEntityId + workspaceId), detach loser
    // (idempotent re-home). Else leave on loser + log — do NOT drop data.
    const facetRepo = new FacetRepository(tx as unknown as Db, eventRepo);
    const liveFacets = await tx
      .select()
      .from(entityFacets)
      .where(
        and(eq(entityFacets.entityId, loserId), isNull(entityFacets.deletedAt))
      );

    for (const facet of liveFacets) {
      // Pre-check: if winner already has an equivalent live facet, only
      // soft-detach the loser (do NOT stamp winnerFacetIds — unmerge must not
      // detach the winner's pre-existing role).
      const winnerMatch = await findLiveEquivalentFacet(tx as unknown as Db, {
        entityId: winnerId,
        profileId: facet.profileId,
        contextEntityId: facet.contextEntityId ?? null,
        workspaceId: facet.workspaceId ?? null,
      });
      if (winnerMatch) {
        await facetRepo.detach(facet.id, facet.userId);
        movedFacetIds.push(facet.id);
        logger.info(
          {
            facetId: facet.id,
            winnerFacetId: winnerMatch.id,
            winnerId,
            loserId,
          },
          "entity-merge: winner already has equivalent facet — detached loser"
        );
        continue;
      }

      try {
        const attached = await facetRepo.attach(
          {
            entityId: winnerId,
            profileId: facet.profileId,
            userId: facet.userId,
            workspaceId: facet.workspaceId,
            contextEntityId: facet.contextEntityId,
            status: facet.status ?? undefined,
            properties: (facet.properties ?? {}) as Record<string, unknown>,
            skipValidation: true,
            skipEvent: true,
            createdByKind: facet.createdByKind ?? undefined,
            createdByUserId: facet.createdByUserId ?? undefined,
            agentUserId: facet.agentUserId ?? undefined,
            sourceProposalId: facet.sourceProposalId ?? undefined,
            correlationId: facet.correlationId ?? undefined,
          },
          facet.userId
        );
        // Soft-detach loser facet via FacetRepository (never hard-deletes).
        // Silent eventRepo swallows the detach domain event mid-merge.
        await facetRepo.detach(facet.id, facet.userId);
        movedFacetIds.push(facet.id);
        // Stamp the winner facet we just attached so unmerge can soft-detach it.
        if (attached?.id && attached.id !== facet.id) {
          winnerFacetIds.push(attached.id);
        }
      } catch (err) {
        // Attach failed and winner has no equivalent — leave live on loser.
        logger.warn(
          { err, facetId: facet.id, winnerId, loserId },
          "entity-merge: facet attach failed — left on loser (no winner equivalent; data preserved)"
        );
      }
    }

    // 7b. Re-point facets on OTHER entities where contextEntityId = loserId.
    // Live rows only; skip rows that would violate the unique index
    // (entityId, profileId, COALESCE(contextEntityId), COALESCE(workspaceId)).
    // Not stamped for unmerge (residual: contextEntityId re-points stay on winner).
    const contextFacets = await tx
      .select()
      .from(entityFacets)
      .where(
        and(
          eq(entityFacets.contextEntityId, loserId),
          isNull(entityFacets.deletedAt)
        )
      );

    for (const facet of contextFacets) {
      try {
        await tx
          .update(entityFacets)
          .set({ contextEntityId: winnerId, updatedAt: new Date() })
          .where(eq(entityFacets.id, facet.id));
      } catch (err) {
        if (isUniqueViolation(err)) {
          logger.info(
            {
              facetId: facet.id,
              entityId: facet.entityId,
              profileId: facet.profileId,
              winnerId,
              loserId,
            },
            "entity-merge: contextEntityId re-point skipped (unique conflict on winner context)"
          );
        } else {
          throw err;
        }
      }
    }

    // 8. Soft-delete loser + stamp mergedInto.
    // When document was moved, clear loser's documentId so only winner owns it.
    const loserSystemData = {
      ...((loser.systemData ?? {}) as Record<string, unknown>),
      mergedInto: winnerId,
    };
    await tx
      .update(entities)
      .set({
        deletedAt: new Date(),
        systemData: loserSystemData,
        updatedAt: new Date(),
        ...(documentMoved ? { documentId: null } : {}),
      })
      .where(eq(entities.id, loserId));

    const stamp: MergeMaterializedStamp = {
      movedSignalIds,
      rewiredRelations,
      movedFacetIds,
      movedExternalLinkIds,
      documentMoved,
    };
    if (winnerFacetIds.length > 0) stamp.winnerFacetIds = winnerFacetIds;
    if (rewiredMessageLinkIds.length > 0) {
      stamp.rewiredMessageLinkIds = rewiredMessageLinkIds;
    }
    if (rewiredLinkIds.length > 0) stamp.rewiredLinkIds = rewiredLinkIds;
    if (deletedRelationIds.length > 0) {
      stamp.deletedRelationIds = deletedRelationIds;
    }
    return stamp;
  });

  return {
    winnerId,
    loserId,
    plan,
    previousWinnerSnapshot,
    previousLoserSnapshot,
    materialized,
  };
}

// ── Unmerge door ─────────────────────────────────────────────────────────────

export interface UnmergeEntityInput {
  winnerId: string;
  loserId: string;
  userId: string;
  previousWinnerSnapshot: {
    title?: string | null;
    preview?: string | null;
    properties?: Record<string, unknown>;
    documentId?: string | null;
    systemData?: Record<string, unknown>;
  };
  previousLoserSnapshot?: {
    title?: string | null;
    preview?: string | null;
    properties?: Record<string, unknown>;
    documentId?: string | null;
    systemData?: Record<string, unknown>;
  };
  materialized: MergeMaterializedStamp;
  /**
   * Optional event repo for FacetRepository detach domain events.
   * Same contract as mergeEntities — omit for silent data-plane-only unmerge.
   */
  eventRepo?: EventRepository;
}

/**
 * Pure validation for unmerge inputs. Throws Error with a clear message when
 * the stamp/snapshots cannot support a full unmerge. No DB access.
 */
export function assertUnmergeable(
  input: Pick<
    UnmergeEntityInput,
    "winnerId" | "loserId" | "previousWinnerSnapshot" | "materialized"
  >
): void {
  if (!input.winnerId || !input.loserId) {
    throw new Error("unmerge requires winnerId and loserId");
  }
  if (input.winnerId === input.loserId) {
    throw new Error("Cannot unmerge an entity from itself");
  }
  if (!input.previousWinnerSnapshot) {
    throw new Error(
      "unmerge requires previousWinnerSnapshot (pre-merge winner state missing)"
    );
  }
  if (!input.materialized || typeof input.materialized !== "object") {
    throw new Error(
      "unmerge requires materialized merge stamp (approve stamp missing)"
    );
  }
  // Arrays may be empty (merge with no side rows) but must be present as arrays
  // for the fields merge always stamps.
  const m = input.materialized;
  if (!Array.isArray(m.movedSignalIds)) {
    throw new Error(
      "unmerge materialized stamp missing movedSignalIds (incomplete stamp)"
    );
  }
  if (!Array.isArray(m.movedExternalLinkIds)) {
    throw new Error(
      "unmerge materialized stamp missing movedExternalLinkIds (incomplete stamp)"
    );
  }
  if (!Array.isArray(m.movedFacetIds)) {
    throw new Error(
      "unmerge materialized stamp missing movedFacetIds (incomplete stamp)"
    );
  }
  if (!Array.isArray(m.rewiredRelations)) {
    throw new Error(
      "unmerge materialized stamp missing rewiredRelations (incomplete stamp; legacy rewiredRelationIds-only stamps cannot full-unmerge)"
    );
  }
  if (typeof m.documentMoved !== "boolean") {
    throw new Error(
      "unmerge materialized stamp missing documentMoved (incomplete stamp)"
    );
  }
}

/**
 * Invert a prior mergeEntities call using its invertibility stamp + snapshots.
 * Atomic data-plane mutation. Does NOT emit search/embedding/automation
 * side-effects — the proposal revert path is responsible.
 *
 * Irreversible: deletedRelationIds (self-loop/dedupe drops) cannot resurrect —
 * logged only. contextEntityId re-points from merge are not reversed.
 */
export async function unmergeEntities(
  db: Db,
  input: UnmergeEntityInput
): Promise<{ winnerId: string; loserId: string }> {
  assertUnmergeable(input);

  const {
    winnerId,
    loserId,
    userId,
    previousWinnerSnapshot,
    previousLoserSnapshot,
    materialized,
  } = input;

  const [winner, loser] = await Promise.all([
    db.query.entities.findFirst({ where: eq(entities.id, winnerId) }),
    db.query.entities.findFirst({ where: eq(entities.id, loserId) }),
  ]);

  if (!winner) {
    throw new Error(`Winner entity ${winnerId} not found`);
  }
  if (!loser) {
    throw new Error(`Loser entity ${loserId} not found`);
  }
  if (winner.userId !== userId || loser.userId !== userId) {
    throw new Error(
      `Unmerge userId ${userId} does not match entity owners (winner=${winner.userId}, loser=${loser.userId})`
    );
  }

  const irreversibleCount = materialized.deletedRelationIds?.length ?? 0;
  if (irreversibleCount > 0) {
    logger.info(
      { winnerId, loserId, deletedRelationIds: irreversibleCount },
      "entity-unmerge: cannot resurrect deletedRelationIds (self-loop/dedupe drops)"
    );
  }

  const silentEventRepo = createSilentEventRepo();
  const eventRepo = input.eventRepo ?? silentEventRepo;

  await db.transaction(async (tx) => {
    // 1. Soft-detach facets created/attached on winner during merge.
    if (materialized.winnerFacetIds && materialized.winnerFacetIds.length > 0) {
      const facetRepo = new FacetRepository(tx as unknown as Db, eventRepo);
      for (const facetId of materialized.winnerFacetIds) {
        // FacetRepository.detach is the one door (soft-delete, never hard).
        // Ownership-gated on userId — matches the entity owner we asserted above.
        await facetRepo.detach(facetId, userId);
      }
    }

    // 2. Undelete moved facets on loser.
    for (const facetId of materialized.movedFacetIds) {
      await tx
        .update(entityFacets)
        .set({
          deletedAt: null,
          entityId: loserId,
          updatedAt: new Date(),
        })
        .where(eq(entityFacets.id, facetId));
    }

    // 3. Reverse rewired relations using previous source/target.
    for (const rel of materialized.rewiredRelations) {
      await tx
        .update(relations)
        .set({
          sourceEntityId: rel.previousSourceEntityId,
          targetEntityId: rel.previousTargetEntityId,
        })
        .where(eq(relations.id, rel.id));
    }

    // 4. Reverse message_links: targetId winner → loser for stamped ids
    // that still point at the winner.
    if (
      materialized.rewiredMessageLinkIds &&
      materialized.rewiredMessageLinkIds.length > 0
    ) {
      for (const linkId of materialized.rewiredMessageLinkIds) {
        await tx
          .update(messageLinks)
          .set({ targetId: loserId })
          .where(
            and(
              eq(messageLinks.id, linkId),
              eq(messageLinks.targetType, "entity"),
              eq(messageLinks.targetId, winnerId)
            )
          );
      }
    }

    // 5. Reverse external links moved → entityId loser (if still on winner).
    for (const linkId of materialized.movedExternalLinkIds) {
      await tx
        .update(entityExternalLinks)
        .set({ entityId: loserId })
        .where(
          and(
            eq(entityExternalLinks.id, linkId),
            eq(entityExternalLinks.entityId, winnerId)
          )
        );
    }

    // 6. Reverse signals: if still on winner, reassign entityId → loser.
    // Unique is (signalType, signalValue) so a plain entityId update is safe.
    for (const signalId of materialized.movedSignalIds) {
      await tx
        .update(entityIdentitySignals)
        .set({ entityId: loserId })
        .where(
          and(
            eq(entityIdentitySignals.id, signalId),
            eq(entityIdentitySignals.entityId, winnerId)
          )
        );
    }

    // 6b. Reverse polymorphic links: entity endpoints currently on winner
    // that were rewired from loser → set back to loser (best-effort by id).
    if (materialized.rewiredLinkIds && materialized.rewiredLinkIds.length > 0) {
      for (const linkId of materialized.rewiredLinkIds) {
        const [edge] = await tx
          .select()
          .from(links)
          .where(eq(links.id, linkId))
          .limit(1);
        if (!edge) continue;
        const nextFromId =
          edge.fromType === "entity" && edge.fromId === winnerId
            ? loserId
            : edge.fromId;
        const nextToId =
          edge.toType === "entity" && edge.toId === winnerId
            ? loserId
            : edge.toId;
        if (nextFromId === edge.fromId && nextToId === edge.toId) continue;
        try {
          await tx
            .update(links)
            .set({ fromId: nextFromId, toId: nextToId })
            .where(eq(links.id, linkId));
        } catch (err) {
          if (isUniqueViolation(err)) {
            logger.info(
              { linkId, winnerId, loserId },
              "entity-unmerge: link reverse skipped (unique conflict)"
            );
          } else {
            throw err;
          }
        }
      }
    }

    // 7. Restore winner fields from previousWinnerSnapshot.
    const winnerSystemData =
      previousWinnerSnapshot.systemData !== undefined
        ? { ...previousWinnerSnapshot.systemData }
        : {
            ...((winner.systemData ?? {}) as Record<string, unknown>),
          };
    await tx
      .update(entities)
      .set({
        title:
          previousWinnerSnapshot.title !== undefined
            ? previousWinnerSnapshot.title
            : winner.title,
        preview:
          previousWinnerSnapshot.preview !== undefined
            ? previousWinnerSnapshot.preview
            : winner.preview,
        properties:
          previousWinnerSnapshot.properties !== undefined
            ? previousWinnerSnapshot.properties
            : ((winner.properties ?? {}) as Record<string, unknown>),
        documentId:
          previousWinnerSnapshot.documentId !== undefined
            ? previousWinnerSnapshot.documentId
            : winner.documentId,
        systemData: winnerSystemData,
        version: winner.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(entities.id, winnerId));

    // 8. Restore loser: undelete, restore snapshot fields, clear mergedInto.
    // Snapshot restore also puts documentId back when documentMoved.
    const loserBaseSystem =
      previousLoserSnapshot?.systemData !== undefined
        ? { ...previousLoserSnapshot.systemData }
        : {
            ...((loser.systemData ?? {}) as Record<string, unknown>),
          };
    delete loserBaseSystem.mergedInto;

    const loserTitle =
      previousLoserSnapshot?.title !== undefined
        ? previousLoserSnapshot.title
        : loser.title;
    const loserPreview =
      previousLoserSnapshot?.preview !== undefined
        ? previousLoserSnapshot.preview
        : loser.preview;
    const loserProperties =
      previousLoserSnapshot?.properties !== undefined
        ? previousLoserSnapshot.properties
        : ((loser.properties ?? {}) as Record<string, unknown>);
    const loserDocumentId =
      previousLoserSnapshot?.documentId !== undefined
        ? previousLoserSnapshot.documentId
        : loser.documentId;

    await tx
      .update(entities)
      .set({
        deletedAt: null,
        title: loserTitle,
        preview: loserPreview,
        properties: loserProperties,
        documentId: loserDocumentId,
        systemData: loserBaseSystem,
        version: loser.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(entities.id, loserId));
  });

  return { winnerId, loserId };
}

// ── Internals ────────────────────────────────────────────────────────────────

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  let cursor: unknown = error;
  for (
    let depth = 0;
    cursor && typeof cursor === "object" && depth < 4;
    depth++
  ) {
    if ((cursor as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Live facet match on the unique-index key (entityId, profileId,
 * contextEntityId, workspaceId) — NULL-safe for the two nullable columns.
 * Mirrors FacetRepository.findLiveMatch (private there).
 */
async function findLiveEquivalentFacet(
  db: Db,
  key: {
    entityId: string;
    profileId: string;
    contextEntityId: string | null;
    workspaceId: string | null;
  }
): Promise<{ id: string } | null> {
  const conditions = [
    eq(entityFacets.entityId, key.entityId),
    eq(entityFacets.profileId, key.profileId),
    isNull(entityFacets.deletedAt),
    key.contextEntityId
      ? eq(entityFacets.contextEntityId, key.contextEntityId)
      : isNull(entityFacets.contextEntityId),
    key.workspaceId
      ? eq(entityFacets.workspaceId, key.workspaceId)
      : isNull(entityFacets.workspaceId),
  ];
  const [row] = await db
    .select({ id: entityFacets.id })
    .from(entityFacets)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

/** No-op EventRepository so FacetRepository can run without writing events. */
function createSilentEventRepo(): EventRepository {
  return {
    append: async () =>
      ({
        id: "silent",
        timestamp: new Date(),
        subjectId: "silent",
        subjectType: "entity_facet",
        eventType: "silent",
        userId: "silent",
        data: {},
        version: 1,
        source: "system",
      }) as Awaited<ReturnType<EventRepository["append"]>>,
  } as unknown as EventRepository;
}
