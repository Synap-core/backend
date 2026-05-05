/**
 * Domain event → Socket.IO bridge
 *
 * When events are appended to the event store (entity, view, relation, document,
 * workspace, workspace member), this utility forwards .completed events to the
 * Realtime server's /bridge/emit so connected Socket.IO clients receive them.
 * The frontend useRealtimeSync then invalidates the right TanStack Query caches.
 *
 * Event type mapping (backend eventType → Socket.IO event name):
 * - entity.*.completed → entity:created | entity:updated | entity:deleted
 * - view.*.completed → view:created | view:updated | view:deleted
 * - workspaces.update.completed → workspace:updated
 * - relation.*.completed → relation:created | relation:updated | relation:deleted
 * - document.*.completed → document:created | document:updated | document:deleted
 * - workspaceMembers.add.completed → workspace:member_added
 * - workspaceMembers.remove.completed → workspace:member_removed
 */

import type { EventRecord } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { EventNames } from "@synap-core/types/events";

const logger = createLogger({ module: "domain-event-bridge" });

function getRealtimeUrl(): string {
  return process.env.REALTIME_URL || "http://localhost:4001";
}

/** Map backend eventType to Socket.IO event name and whether we have workspaceId for targeting. */
function mapToSocketEvent(
  eventType: string
): { event: string; workspaceIdRequired: boolean } | null {
  const m: Record<string, { event: string; workspaceIdRequired: boolean }> = {
    "entity.create.completed": {
      event: EventNames.ENTITY_CREATED,
      workspaceIdRequired: true,
    },
    "entity.update.completed": {
      event: EventNames.ENTITY_UPDATED,
      workspaceIdRequired: true,
    },
    "entity.delete.completed": {
      event: EventNames.ENTITY_DELETED,
      workspaceIdRequired: true,
    },
    "view.create.completed": {
      event: "view:created",
      workspaceIdRequired: true,
    },
    "view.update.completed": {
      event: "view:updated",
      workspaceIdRequired: true,
    },
    "view.delete.completed": {
      event: "view:deleted",
      workspaceIdRequired: true,
    },
    "workspaces.update.completed": {
      event: "workspace:updated",
      workspaceIdRequired: true,
    },
    "relation.create.completed": {
      event: "relation:created",
      workspaceIdRequired: true,
    },
    "relation.update.completed": {
      event: "relation:updated",
      workspaceIdRequired: true,
    },
    "relation.delete.completed": {
      event: "relation:deleted",
      workspaceIdRequired: true,
    },
    "document.create.completed": {
      event: "document:created",
      workspaceIdRequired: true,
    },
    "document.update.completed": {
      event: EventNames.DOCUMENT_UPDATED,
      workspaceIdRequired: true,
    },
    "document.delete.completed": {
      event: "document:deleted",
      workspaceIdRequired: true,
    },
    "workspaceMembers.add.completed": {
      event: "workspace:member_added",
      workspaceIdRequired: true,
    },
    "workspaceMembers.remove.completed": {
      event: "workspace:member_removed",
      workspaceIdRequired: true,
    },
  };
  return m[eventType] ?? null;
}

/**
 * Forward a domain event to the Realtime server so Socket.IO clients can update their caches.
 * Fire-and-forget: we do not await so event storage is not blocked.
 */
export function emitDomainEventToRealtime(event: EventRecord): void {
  const mapped = mapToSocketEvent(event.eventType);
  if (!mapped) return;

  let workspaceId =
    (event.data?.workspaceId as string | undefined) ?? undefined;
  // For workspace.* events, subjectId is the workspace id
  if (!workspaceId && event.eventType.startsWith("workspaces.")) {
    workspaceId = event.subjectId;
  }
  if (mapped.workspaceIdRequired && !workspaceId) {
    logger.debug(
      { eventType: event.eventType, subjectId: event.subjectId },
      "Skipping bridge emit: no workspaceId in event data"
    );
    return;
  }

  const url = `${getRealtimeUrl()}/bridge/emit`;
  const payloadData = {
    ...event.data,
    subjectId: event.subjectId,
    subjectType: event.subjectType,
    userId: event.userId,
    eventType: event.eventType,
  } as Record<string, unknown>;
  // So frontend can invalidate documents.get({ documentId })
  if (event.eventType.startsWith("document.")) {
    payloadData.documentId = event.subjectId;
  }
  const body = JSON.stringify({
    event: mapped.event,
    data: payloadData,
    ...(workspaceId && { workspaceId }),
  });

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).catch((err) => {
    logger.warn(
      { err, eventType: event.eventType, socketEvent: mapped.event },
      "Domain event bridge: failed to emit to realtime"
    );
  });
}
