/**
 * Event Helper Library
 *
 * Provides type-safe event logging functions for all domain events.
 * Follows the requested→validated pattern for all mutations.
 */

import { db } from "@synap/database";
import { events } from "@synap/database/schema";
import { randomUUID } from "crypto";

/**
 * The closed set of valid event sources — mirrors `SynapEventSchema` in
 * `@synap-core/core`. `events.source` is a plain `text` column (no DB check
 * constraint), and THIS raw-insert path has no Zod gate (unlike `auditLog`),
 * so without a guard an invalid source (e.g. the legacy `"agent"`) drifts
 * silently into the event spine — a class of data-integrity bug that consumers
 * treating `source` as a closed union then mis-handle. `normalizeEventSource`
 * is the ONE place that guarantees a valid value: it maps known legacy aliases
 * to their canonical member and coerces anything else to `"api"` with a warn.
 */
const VALID_EVENT_SOURCES = new Set([
  "api",
  "automation",
  "sync",
  "migration",
  "system",
  "intelligence",
]);

/** Legacy/business values callers have historically passed as a `source`. */
const EVENT_SOURCE_ALIASES: Record<string, string> = {
  agent: "intelligence", // agent authorship lives on agentUserId, not source
  ai: "intelligence",
  user: "api",
};

export function normalizeEventSource(
  source: string | undefined | null
): string {
  if (!source) return "api";
  if (VALID_EVENT_SOURCES.has(source)) return source;
  const aliased = EVENT_SOURCE_ALIASES[source];
  if (aliased) return aliased;
  console.warn(`[Event] coercing unknown event source "${source}" → "api"`);
  return "api";
}

/**
 * Base event logging function.
 *
 * Returns the id of the inserted event so callers (e.g. the permission gate)
 * can link the proposal back to the originating `.requested` event on the
 * spine. The id is pre-generated rather than read back via `.returning()`
 * because `events` has a composite PK (id, timestamp).
 */
export async function logEvent(
  userId: string,
  type: string,
  data: Record<string, any>,
  options?: {
    subjectId?: string;
    subjectType?: string;
    metadata?: Record<string, any>;
    source?: string;
  },
  /**
   * Optional executor — pass a Drizzle transaction handle to append the event
   * inside an open transaction (so the `.requested` append and the proposal
   * INSERT commit atomically). Defaults to the module-level `db`.
   */
  executor: Pick<typeof db, "insert"> = db
): Promise<string> {
  const eventId = randomUUID();
  await executor.insert(events).values({
    id: eventId,
    userId,
    type,
    data,
    subjectId: options?.subjectId || "unknown",
    subjectType: options?.subjectType || "unknown",
    metadata: options?.metadata || {},
    source: normalizeEventSource(options?.source),
    timestamp: new Date(),
  });

  console.log(`[Event] ${type}`, { userId, subjectId: options?.subjectId });

  return eventId;
}

// ============================================================================
// WORKSPACE EVENTS
// ============================================================================

export const WorkspaceEvents = {
  createRequested: (
    userId: string,
    data: { name: string; type: string; description?: string }
  ) =>
    logEvent(userId, "workspace.create.requested", data, {
      subjectType: "workspace",
    }),

  createValidated: (
    userId: string,
    workspace: { id: string; name: string; type: string; ownerId: string }
  ) =>
    logEvent(userId, "workspace.create.validated", workspace, {
      subjectId: workspace.id,
      subjectType: "workspace",
    }),

  updateRequested: (
    userId: string,
    workspaceId: string,
    updates: Record<string, any>
  ) =>
    logEvent(
      userId,
      "workspace.update.requested",
      { updates },
      {
        subjectId: workspaceId,
        subjectType: "workspace",
      }
    ),

  updateValidated: (
    userId: string,
    workspaceId: string,
    changes: Record<string, any>
  ) =>
    logEvent(
      userId,
      "workspace.update.validated",
      { id: workspaceId, changes },
      {
        subjectId: workspaceId,
        subjectType: "workspace",
      }
    ),

  deleteRequested: (userId: string, workspaceId: string) =>
    logEvent(
      userId,
      "workspace.delete.requested",
      { id: workspaceId },
      {
        subjectId: workspaceId,
        subjectType: "workspace",
      }
    ),

  deleteValidated: (userId: string, workspaceId: string) =>
    logEvent(
      userId,
      "workspace.delete.validated",
      { id: workspaceId },
      {
        subjectId: workspaceId,
        subjectType: "workspace",
      }
    ),
};

export const WorkspaceMemberEvents = {
  inviteRequested: (
    userId: string,
    data: { workspaceId: string; email: string; role: string }
  ) =>
    logEvent(userId, "workspaceMembers.create.requested", data, {
      subjectId: data.workspaceId,
      subjectType: "workspace_member",
    }),

  inviteValidated: (
    userId: string,
    member: { id: string; workspaceId: string; userId: string; role: string }
  ) =>
    logEvent(userId, "workspaceMembers.create.validated", member, {
      subjectId: member.id,
      subjectType: "workspace_member",
    }),

  removeRequested: (userId: string, workspaceId: string, memberId: string) =>
    logEvent(
      userId,
      "workspaceMembers.delete.requested",
      { workspaceId, memberId },
      {
        subjectId: memberId,
        subjectType: "workspace_member",
      }
    ),

  removeValidated: (userId: string, memberId: string) =>
    logEvent(
      userId,
      "workspaceMembers.delete.validated",
      { id: memberId },
      {
        subjectId: memberId,
        subjectType: "workspace_member",
      }
    ),
};

// ============================================================================
// VIEW EVENTS
// ============================================================================

export const ViewEvents = {
  createRequested: (
    userId: string,
    data: { type: string; name: string; workspaceId?: string }
  ) =>
    logEvent(userId, "view.create.requested", data, {
      subjectType: "view",
    }),

  createValidated: (
    userId: string,
    view: { id: string; type: string; name: string; documentId: string }
  ) =>
    logEvent(userId, "view.create.validated", view, {
      subjectId: view.id,
      subjectType: "view",
    }),

  updateRequested: (
    userId: string,
    viewId: string,
    saveType: "manual" | "publish"
  ) =>
    logEvent(
      userId,
      "view.update.requested",
      { saveType },
      {
        subjectId: viewId,
        subjectType: "view",
      }
    ),

  updateValidated: (userId: string, viewId: string, versionNumber: number) =>
    logEvent(
      userId,
      "view.update.validated",
      {
        id: viewId,
        versionNumber,
        savedAt: new Date(),
      },
      {
        subjectId: viewId,
        subjectType: "view",
      }
    ),

  deleteRequested: (userId: string, viewId: string) =>
    logEvent(
      userId,
      "view.delete.requested",
      { id: viewId },
      {
        subjectId: viewId,
        subjectType: "view",
      }
    ),

  deleteValidated: (userId: string, viewId: string) =>
    logEvent(
      userId,
      "view.delete.validated",
      { id: viewId },
      {
        subjectId: viewId,
        subjectType: "view",
      }
    ),
};

// ============================================================================
// USER PREFERENCES EVENTS
// ============================================================================

export const UserPreferencesEvents = {
  updateRequested: (userId: string, changes: Record<string, any>) =>
    logEvent(
      userId,
      "userPreferences.update.requested",
      { changes },
      {
        subjectId: userId,
        subjectType: "user_preferences",
      }
    ),

  updateValidated: (userId: string, changes: Record<string, any>) =>
    logEvent(
      userId,
      "userPreferences.update.validated",
      { userId, changes },
      {
        subjectId: userId,
        subjectType: "user_preferences",
      }
    ),
};

// ============================================================================
// ENTITY EVENTS
// ============================================================================

export const EntityEvents = {
  createRequested: (
    userId: string,
    data: { type: string; title: string; workspaceId?: string }
  ) =>
    logEvent(userId, "entity.create.requested", data, {
      subjectType: "entity",
    }),

  createValidated: (
    userId: string,
    entity: { id: string; type: string; title: string }
  ) =>
    logEvent(userId, "entity.create.validated", entity, {
      subjectId: entity.id,
      subjectType: "entity",
    }),

  createDenied: (userId: string, data: { reason: string; entityData: any }) =>
    logEvent(userId, "entity.create.denied", data, {
      subjectType: "entity",
    }),

  updateRequested: (
    userId: string,
    entityId: string,
    updates: Record<string, any>
  ) =>
    logEvent(
      userId,
      "entity.update.requested",
      { updates },
      {
        subjectId: entityId,
        subjectType: "entity",
      }
    ),

  updateValidated: (
    userId: string,
    entityId: string,
    changes: Record<string, any>
  ) =>
    logEvent(
      userId,
      "entity.update.validated",
      { id: entityId, changes },
      {
        subjectId: entityId,
        subjectType: "entity",
      }
    ),

  updateDenied: (userId: string, entityId: string, reason: string) =>
    logEvent(
      userId,
      "entity.update.denied",
      { id: entityId, reason },
      {
        subjectId: entityId,
        subjectType: "entity",
      }
    ),

  deleteRequested: (userId: string, entityId: string) =>
    logEvent(
      userId,
      "entity.delete.requested",
      { id: entityId },
      {
        subjectId: entityId,
        subjectType: "entity",
      }
    ),

  deleteValidated: (userId: string, entityId: string) =>
    logEvent(
      userId,
      "entity.delete.validated",
      { id: entityId },
      {
        subjectId: entityId,
        subjectType: "entity",
      }
    ),

  deleteDenied: (userId: string, entityId: string, reason: string) =>
    logEvent(
      userId,
      "entity.delete.denied",
      { id: entityId, reason },
      {
        subjectId: entityId,
        subjectType: "entity",
      }
    ),
};

// ============================================================================
// RELATION EVENTS
// ============================================================================

export const RelationEvents = {
  createRequested: (
    userId: string,
    data: { fromId: string; toId: string; type: string }
  ) =>
    logEvent(userId, "relation.create.requested", data, {
      subjectType: "relation",
    }),

  createValidated: (
    userId: string,
    relation: { id: string; fromId: string; toId: string }
  ) =>
    logEvent(userId, "relation.create.validated", relation, {
      subjectId: relation.id,
      subjectType: "relation",
    }),

  deleteRequested: (userId: string, relationId: string) =>
    logEvent(
      userId,
      "relation.delete.requested",
      { id: relationId },
      {
        subjectId: relationId,
        subjectType: "relation",
      }
    ),

  deleteValidated: (userId: string, relationId: string) =>
    logEvent(
      userId,
      "relation.delete.validated",
      { id: relationId },
      {
        subjectId: relationId,
        subjectType: "relation",
      }
    ),
};
