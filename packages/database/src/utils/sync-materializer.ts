/**
 * Sync Materializer — Shared event materialization logic for pod-to-pod sync.
 *
 * Used by both:
 * - POST /api/sync/receive (push-receive from remote peer)
 * - sync-pull worker (pull-receive from remote peer)
 *
 * Includes last-write-wins conflict resolution: if the local row is newer
 * than the incoming event, the event is skipped and a conflict is logged.
 */

import { z } from "zod";
import { createLogger } from "@synap-core/core";
import { eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import { events } from "../schema/events.js";
import { entities } from "../schema/entities.js";
import { views } from "../schema/views.js";
import { documents } from "../schema/documents.js";
import { relations } from "../schema/relations.js";
import { profiles, ProfileScope } from "../schema/profiles.js";
import { syncConflicts } from "../schema/sync.js";
import { reservedProfileSlugReason } from "./reserved-profile-slugs.js";

const logger = createLogger({ module: "sync-materializer" });

// ============================================================================
// Input schema (shared between push-receive and pull-receive)
// ============================================================================

export const syncEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  data: z.unknown(),
  metadata: z.unknown().optional(),
  source: z.string().optional(),
  userId: z.string().optional(),
  timestamp: z.string(), // ISO datetime
  correlationId: z.string().optional(),
});

export const syncReceiveInputSchema = z.object({
  events: z.array(syncEventSchema),
  cursor: z.string(), // ISO datetime of last event in batch
});

export type SyncEvent = z.infer<typeof syncEventSchema>;

// ============================================================================
// Event type parser
// ============================================================================

/**
 * Parse event type to extract subject + action.
 * e.g. "entity.create.completed" -> { subject: "entity", action: "create" }
 */
function parseEventType(type: string): {
  subject: string;
  action: string;
} | null {
  const parts = type.split(".");
  if (parts.length < 3 || parts[parts.length - 1] !== "completed") return null;
  return { subject: parts[0], action: parts[1] };
}

// ============================================================================
// Conflict detection — last-write-wins
// ============================================================================

interface ConflictCheckResult {
  hasConflict: boolean;
  localTimestamp: Date | null;
  resolution: "local_wins" | "remote_wins" | null;
}

/**
 * Check if the local row is newer than the incoming event.
 * Returns the conflict info for logging.
 */
async function checkConflict(
  subject: string,
  subjectId: string,
  eventTimestamp: Date
): Promise<ConflictCheckResult> {
  let localRow: { updatedAt: Date | null } | undefined;

  try {
    switch (subject) {
      case "entity":
        localRow = await db.query.entities.findFirst({
          where: eq(entities.id, subjectId),
          columns: { updatedAt: true },
        });
        break;
      case "view":
        localRow = await db.query.views.findFirst({
          where: eq(views.id, subjectId),
          columns: { updatedAt: true },
        });
        break;
      case "document":
        localRow = await db.query.documents.findFirst({
          where: eq(documents.id, subjectId),
          columns: { updatedAt: true },
        });
        break;
      case "profile":
        localRow = await db.query.profiles.findFirst({
          where: eq(profiles.id, subjectId),
          columns: { updatedAt: true },
        });
        break;
      // Relations don't have updatedAt — no conflict check needed (create/delete only)
      default:
        return { hasConflict: false, localTimestamp: null, resolution: null };
    }
  } catch {
    // If we can't read the local row, proceed with the remote event
    return { hasConflict: false, localTimestamp: null, resolution: null };
  }

  if (!localRow || !localRow.updatedAt) {
    // No local row — this is a create, no conflict
    return { hasConflict: false, localTimestamp: null, resolution: null };
  }

  const localTs = localRow.updatedAt;
  if (localTs > eventTimestamp) {
    return {
      hasConflict: true,
      localTimestamp: localTs,
      resolution: "local_wins",
    };
  }

  if (localTs.getTime() === eventTimestamp.getTime()) {
    // Exact same timestamp — treat as no-op (already applied)
    return {
      hasConflict: true,
      localTimestamp: localTs,
      resolution: "local_wins",
    };
  }

  // Remote is newer — apply it
  return {
    hasConflict: true,
    localTimestamp: localTs,
    resolution: "remote_wins",
  };
}

/**
 * Log a conflict to the sync_conflicts table.
 */
async function logConflict(opts: {
  syncPeerId: string | null;
  subjectType: string;
  subjectId: string;
  localTimestamp: Date | null;
  remoteTimestamp: Date;
  resolution: "local_wins" | "remote_wins";
  eventData: unknown;
}): Promise<void> {
  try {
    await db.insert(syncConflicts).values({
      syncPeerId: opts.syncPeerId,
      subjectType: opts.subjectType,
      subjectId: opts.subjectId,
      localTimestamp: opts.localTimestamp,
      remoteTimestamp: opts.remoteTimestamp,
      resolution: opts.resolution,
      eventData: opts.eventData,
    });
  } catch (err) {
    // Non-fatal — don't block sync for conflict logging failures
    logger.warn(
      { subjectId: opts.subjectId, err },
      "Failed to log sync conflict"
    );
  }
}

// ============================================================================
// Event materializer — idempotent upserts with conflict resolution
// ============================================================================

export interface MaterializeOptions {
  /** Peer ID for conflict logging (null if unknown) */
  syncPeerId?: string | null;
  /** Enable conflict detection (default: true) */
  checkConflicts?: boolean;
}

/**
 * Materialize a single event into the appropriate projection table.
 * Uses upsert (ON CONFLICT DO UPDATE) for idempotency.
 * With conflict detection enabled, skips events when local data is newer.
 *
 * Returns: "applied" | "skipped_conflict" | "skipped_unknown" | "error"
 */
export async function materializeEvent(
  event: SyncEvent,
  opts: MaterializeOptions = {}
): Promise<"applied" | "skipped_conflict" | "skipped_unknown" | "error"> {
  const parsed = parseEventType(event.type);
  if (!parsed) return "skipped_unknown";

  const { subject, action } = parsed;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const eventTimestamp = new Date(event.timestamp);
  const checkConflicts = opts.checkConflicts ?? true;

  try {
    // For create/update actions, check if local row is newer (last-write-wins)
    if (
      checkConflicts &&
      (action === "create" || action === "update") &&
      subject !== "relation"
    ) {
      const conflict = await checkConflict(
        subject,
        event.subjectId,
        eventTimestamp
      );

      if (conflict.hasConflict && conflict.resolution === "local_wins") {
        logger.debug(
          {
            subject,
            subjectId: event.subjectId,
            localTs: conflict.localTimestamp?.toISOString(),
            remoteTs: eventTimestamp.toISOString(),
          },
          "Sync conflict: local wins (skipping incoming event)"
        );

        await logConflict({
          syncPeerId: opts.syncPeerId ?? null,
          subjectType: subject,
          subjectId: event.subjectId,
          localTimestamp: conflict.localTimestamp,
          remoteTimestamp: eventTimestamp,
          resolution: "local_wins",
          eventData: event.data,
        });

        return "skipped_conflict";
      }

      // If remote wins and there was a conflict, log it
      if (conflict.hasConflict && conflict.resolution === "remote_wins") {
        await logConflict({
          syncPeerId: opts.syncPeerId ?? null,
          subjectType: subject,
          subjectId: event.subjectId,
          localTimestamp: conflict.localTimestamp,
          remoteTimestamp: eventTimestamp,
          resolution: "remote_wins",
          eventData: event.data,
        });
      }
    }

    // Apply the event
    switch (subject) {
      case "entity":
        return (await materializeEntity(action, event.subjectId, data))
          ? "applied"
          : "skipped_unknown";
      case "view":
        return (await materializeView(action, event.subjectId, data))
          ? "applied"
          : "skipped_unknown";
      case "document":
        return (await materializeDocument(action, event.subjectId, data))
          ? "applied"
          : "skipped_unknown";
      case "relation":
        return (await materializeRelation(action, event.subjectId, data))
          ? "applied"
          : "skipped_unknown";
      case "profile":
        return (await materializeProfile(action, event.subjectId, data))
          ? "applied"
          : "skipped_unknown";
      default:
        return "skipped_unknown";
    }
  } catch (err) {
    logger.error(
      {
        eventId: event.id,
        eventType: event.type,
        subjectId: event.subjectId,
        err,
      },
      "Failed to materialize event"
    );
    return "error";
  }
}

// ============================================================================
// Per-subject materializers (unchanged logic from Phase 2)
// ============================================================================

/**
 * Resolve the entity's `type` for materialization.
 *
 * `data.type` is replayed verbatim from a remote event and is not
 * authoritative — a corrupt/stale remote `type` (e.g. a role slug where a
 * kind slug belongs) must not be trusted. When `data.profileId` is present,
 * resolve `type` from `profiles.slug` (the authoritative FK) so the row
 * self-heals on replay. Only fall back to `data.type` when there is no
 * profileId to resolve against.
 */
// Exported for the kind-invariant test. This is a second entity-writer that
// bypasses EntityRepository, so its type resolution needs its own guard —
// see sync-materializer.kind-invariant.test.ts.
export async function resolveMaterializedEntityType(
  data: Record<string, unknown>
): Promise<string> {
  const profileId = data.profileId as string | undefined;
  if (profileId) {
    try {
      const profile = await db.query.profiles.findFirst({
        where: eq(profiles.id, profileId),
        columns: { slug: true, profileKind: true, applicableKinds: true },
      });

      // KIND/FACET INVARIANT — `entities.type` is the entity's KIND, never a
      // role it plays. A role (client, partner, investor…) is an entity_facets
      // row on top of a kind, not a type of its own.
      //
      // This path is a SECOND entity-writer: unlike `EntityRepository.create`
      // (which resolves a role to its kind and attaches the role as a facet,
      // guarded by entity-repository.kind-invariant.test.ts), replication does
      // a raw upsert. Returning a role slug here would write `type:'client'`
      // into a peer pod — the exact corruption the canonical door was fixed to
      // prevent, arriving through the back door and then propagating onward to
      // every further peer.
      if (profile?.profileKind === "role") {
        // REFUSE, rather than repair.
        //
        // An earlier version resolved a kind here and let the write proceed.
        // That was half a fix: `data.profileId` still points at the ROLE, so the
        // row lands `type:'person'` with an FK to `client` — internally
        // inconsistent, and any reader that resolves kind from the FK (this
        // function included, on every replay) sees a role again. Repairing one
        // half of a contradiction leaves the contradiction.
        //
        // A source pod that emits an entity whose profileId is a role is itself
        // corrupt: a role should have replicated as an `entity_facets` row on
        // top of a kind, never as the entity's own profile. The correct border
        // behaviour is to reject the event, not to guess a kind for it.
        //
        // Cost is bounded: `materializeEvent` catches per-event and returns
        // "error", so the rest of the batch still replicates and the raw event
        // is still stored — the peer is not blocked, just not obeyed.
        const declared = data.type as string | undefined;
        const applicable = profile.applicableKinds ?? [];

        logger.error(
          {
            profileId,
            roleSlug: profile.slug,
            declaredType: declared,
            applicableKinds: applicable,
          },
          "sync: replicated entity references a ROLE profile — refusing. A role must replicate as a facet on a kind, never as the entity's profile."
        );
        throw new Error(
          `sync-materializer: entity references ROLE profile "${profile.slug}" ` +
            `(declared type: ${declared ?? "none"}). Writing it would leave entities.type ` +
            `and entities.profileId disagreeing, and would corrupt the peer.`
        );
      }

      if (profile?.slug) return profile.slug;
    } catch (err) {
      // A kind/facet violation must NOT be swallowed into the fallback below —
      // that would write the corrupt row anyway. Only profile-lookup failures
      // are recoverable here.
      if (
        err instanceof Error &&
        err.message.startsWith("sync-materializer:")
      ) {
        throw err;
      }
      logger.warn(
        { profileId, err },
        "Failed to resolve profile slug for sync entity type; falling back to event type"
      );
    }
  }
  return (data.type as string) ?? "note";
}

async function materializeEntity(
  action: string,
  subjectId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  if (action === "create" || action === "update") {
    const resolvedType = await resolveMaterializedEntityType(data);
    await db
      .insert(entities)
      .values({
        id: subjectId,
        userId: (data.userId as string) ?? "sync",
        workspaceId: data.workspaceId as string | undefined,
        profileId: data.profileId as string | undefined,
        type: resolvedType,
        title: data.title as string | undefined,
        preview: data.preview as string | undefined,
        documentId: data.documentId as string | undefined,
        properties: data.properties ?? {},
        systemData: data.systemData ?? {},
        version: (data.version as number) ?? 1,
      })
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          title: data.title as string | undefined,
          preview: data.preview as string | undefined,
          profileId: data.profileId as string | undefined,
          type: resolvedType,
          properties: data.properties ?? {},
          systemData: data.systemData ?? {},
          version: (data.version as number) ?? 1,
          updatedAt: new Date(),
        },
      });
    return true;
  }

  if (action === "delete") {
    await db
      .update(entities)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(entities.id, subjectId));
    return true;
  }

  return false;
}

async function materializeView(
  action: string,
  subjectId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  if (action === "create" || action === "update") {
    await db
      .insert(views)
      .values({
        id: subjectId,
        userId: (data.userId as string) ?? "sync",
        workspaceId: data.workspaceId as string | undefined,
        type: (data.type as string) ?? "table",
        category: (data.category as string) ?? "structured",
        name: (data.name as string) ?? "Synced View",
        description: data.description as string | undefined,
        query: data.query ?? {},
        config: data.config ?? {},
      })
      .onConflictDoUpdate({
        target: views.id,
        set: {
          name: data.name as string | undefined,
          description: data.description as string | undefined,
          type: data.type as string | undefined,
          category: data.category as string | undefined,
          query: data.query ?? {},
          config: data.config ?? {},
          updatedAt: new Date(),
        },
      });
    return true;
  }

  if (action === "delete") {
    await db.delete(views).where(eq(views.id, subjectId));
    return true;
  }

  return false;
}

async function materializeDocument(
  action: string,
  subjectId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  if (action === "create" || action === "update") {
    await db
      .insert(documents)
      .values({
        id: subjectId,
        userId: (data.userId as string) ?? "sync",
        workspaceId: (data.workspaceId as string) ?? null,
        title: (data.title as string) ?? "Synced Document",
        type: (data.type as string) ?? "text",
        language: data.language as string | undefined,
        storageUrl: data.storageUrl as string | undefined,
        storageKey: data.storageKey as string | undefined,
        size: (data.size as number) ?? 0,
        mimeType: data.mimeType as string | undefined,
        currentVersion: (data.currentVersion as number) ?? 1,
      })
      .onConflictDoUpdate({
        target: documents.id,
        set: {
          title: data.title as string | undefined,
          type: data.type as string | undefined,
          language: data.language as string | undefined,
          storageUrl: data.storageUrl as string | undefined,
          storageKey: data.storageKey as string | undefined,
          size: data.size as number | undefined,
          mimeType: data.mimeType as string | undefined,
          currentVersion: data.currentVersion as number | undefined,
          updatedAt: new Date(),
        },
      });
    return true;
  }

  if (action === "delete") {
    await db.delete(documents).where(eq(documents.id, subjectId));
    return true;
  }

  return false;
}

async function materializeRelation(
  action: string,
  subjectId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  if (action === "create") {
    await db
      .insert(relations)
      .values({
        id: subjectId,
        userId: (data.userId as string) ?? "sync",
        workspaceId: (data.workspaceId as string) ?? null,
        sourceEntityId: data.sourceEntityId as string,
        targetEntityId: data.targetEntityId as string,
        type: (data.type as string) ?? "related_to",
        metadata: data.metadata ?? {},
      })
      // UNTARGETED on purpose. A targeted `ON CONFLICT (id)` arbitrates the
      // primary key ONLY, so any other unique violation still raises 23505 and
      // aborts the whole sync job. Since migration 0239 `relations` also carries
      // partial unique indexes on the entity↔entity edge, and peer sync
      // legitimately replays an edge the pod already has, that would turn a
      // routine no-op into a failed sync. Untargeted suppresses every unique
      // conflict, which is exactly the intended semantics here: "if this edge
      // already exists in any form, do nothing".
      .onConflictDoNothing();
    return true;
  }

  if (action === "delete") {
    await db.delete(relations).where(eq(relations.id, subjectId));
    return true;
  }

  return false;
}

async function materializeProfile(
  action: string,
  subjectId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  if (action === "create" || action === "update") {
    const slug = (data.slug as string) ?? "unknown";

    // The ONE write to `profiles` that does not go through
    // `ProfileRepository.create()`, so the reservation has to be restated here
    // or peer sync is an open back door — and not only for inserts: the
    // `onConflictDoUpdate` below writes `slug`, so a peer could RENAME an
    // existing local profile onto a reserved slug.
    //
    // Skipped rather than thrown: the caller turns a throw into `"error"`,
    // which reads as "retry me". A reserved slug will never become valid, so
    // this is a permanent, deliberate refusal — logged with the reason so an
    // operator can see which peer is publishing it.
    const reservedReason = reservedProfileSlugReason(slug);
    if (reservedReason) {
      logger.warn(
        { subjectId, slug, action },
        `Sync: refusing peer profile — ${reservedReason}`
      );
      return false;
    }

    const scopeValue = (data.scope as string) ?? ProfileScope.WORKSPACE;
    const validScope = Object.values(ProfileScope).includes(
      scopeValue as ProfileScope
    )
      ? (scopeValue as ProfileScope)
      : ProfileScope.WORKSPACE;

    await db
      .insert(profiles)
      .values({
        id: subjectId,
        slug,
        displayName: (data.displayName as string) ?? "Synced Profile",
        parentProfileId: data.parentProfileId as string | undefined,
        uiHints: data.uiHints ?? {},
        scope: validScope,
      } as typeof profiles.$inferInsert)
      .onConflictDoUpdate({
        target: profiles.id,
        set: {
          slug: data.slug as string | undefined,
          displayName: data.displayName as string | undefined,
          parentProfileId: data.parentProfileId as string | undefined,
          uiHints: data.uiHints ?? {},
          updatedAt: new Date(),
        },
      });
    return true;
  }

  return false; // Profiles are not deleted via sync
}

// ============================================================================
// Store received events in local events table (audit trail)
// ============================================================================

export async function storeReceivedEvents(
  syncEvents: SyncEvent[]
): Promise<number> {
  if (syncEvents.length === 0) return 0;

  let stored = 0;

  for (const evt of syncEvents) {
    try {
      await db
        .insert(events)
        .values({
          id: evt.id,
          type: evt.type,
          subjectType: evt.subjectType,
          subjectId: evt.subjectId,
          data: evt.data ?? {},
          metadata: evt.metadata ?? undefined,
          source: evt.source ?? "sync",
          userId: evt.userId ?? "sync",
          timestamp: new Date(evt.timestamp),
          correlationId: evt.correlationId ?? undefined,
        })
        .onConflictDoNothing(); // Idempotent — skip if already stored
      stored++;
    } catch (err) {
      logger.warn(
        { eventId: evt.id, err },
        "Failed to store received sync event in local events table"
      );
    }
  }

  return stored;
}

/**
 * Materialize a batch of events and store them in the local events table.
 * Returns stats about the batch processing.
 */
export async function materializeBatch(
  incomingEvents: SyncEvent[],
  opts: MaterializeOptions = {}
): Promise<{
  materialized: number;
  conflicts: number;
  stored: number;
}> {
  let materialized = 0;
  let conflicts = 0;

  for (const evt of incomingEvents) {
    const result = await materializeEvent(evt, opts);
    if (result === "applied") materialized++;
    if (result === "skipped_conflict") conflicts++;
  }

  const stored = await storeReceivedEvents(incomingEvents);

  return { materialized, conflicts, stored };
}
