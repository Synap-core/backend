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
 * - widget_definition.*.completed → widget_definition:changed
 * - focus_session.*.completed → focus_session:updated
 * - artifact.changed.completed → artifact:changed
 * - entity_facet.*.completed → entity_facet:attached | entity_facet:updated | entity_facet:detached
 *
 * Room targeting — the unified room rule: an event's row carries a
 * workspaceId → `workspace:<id>`; otherwise (pod-wide, e.g. a facet attached
 * with no workspace lens) → `user:<ownerUserId>`. Pod-wide data is never
 * broadcast to a `pod:<id>` room — it stays owner-only until a facet grants
 * a workspace visibility.
 */

import { randomUUID } from "crypto";
import { projectWorkspaceSettings, type EventRecord } from "@synap/database";
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
    // Widget definitions (cells) — workspaceId optional (pod-global cells have none)
    "widget_definition.create.completed": {
      event: "widget_definition:changed",
      workspaceIdRequired: false,
    },
    "widget_definition.update.completed": {
      event: "widget_definition:changed",
      workspaceIdRequired: false,
    },
    "widget_definition.delete.completed": {
      event: "widget_definition:changed",
      workspaceIdRequired: false,
    },
    // Focus sessions — always workspace-scoped
    "focus_session.create.completed": {
      event: "focus_session:updated",
      workspaceIdRequired: true,
    },
    "focus_session.update.completed": {
      event: "focus_session:updated",
      workspaceIdRequired: true,
    },
    // Artifacts — always workspace-scoped
    "artifact.changed.completed": {
      event: "artifact:changed",
      workspaceIdRequired: true,
    },
    // Agent runs — "watch your agent work". workspaceId lives in event.data
    // (the hub handler nests it there), so workspaceIdRequired targets the
    // workspace room. Carries the full telemetry payload + actor fields.
    "agentRun.create.completed": {
      event: "agent_run:updated",
      workspaceIdRequired: true,
    },
    // Facets — attach/detach is how role-as-lens visibility is granted.
    // workspaceId is optional: null is meaningful (pod-wide facet), and
    // falls back to the owner's `user:<userId>` room via the unified rule.
    "entity_facet.create.completed": {
      event: "entity_facet:attached",
      workspaceIdRequired: false,
    },
    "entity_facet.update.completed": {
      event: "entity_facet:updated",
      workspaceIdRequired: false,
    },
    "entity_facet.delete.completed": {
      event: "entity_facet:detached",
      workspaceIdRequired: false,
    },
  };
  return m[eventType] ?? null;
}

/**
 * Emit a realtime event directly (bypassing the event-store hook chain).
 *
 * Use this for write paths that do not go through EventRepository.append()
 * (e.g. direct Drizzle writes in Hub REST handlers). The payload must include
 * `workspaceId` (where applicable) and the primary entity `id` so the browser
 * can invalidate the right TanStack Query cache entries.
 *
 * This constructs a minimal synthetic EventRecord — just enough for
 * `emitDomainEventToRealtime` to extract the event name and workspace target.
 */
export function emitHubRealtimeEvent(opts: {
  eventType: string;
  subjectId: string;
  userId: string;
  data: Record<string, unknown>;
}): void {
  const record: EventRecord = {
    id: randomUUID(),
    timestamp: new Date(),
    subjectId: opts.subjectId,
    subjectType: opts.eventType.split(".")[0] ?? "unknown",
    eventType: opts.eventType,
    userId: opts.userId,
    data: opts.data,
    version: 1,
    source: "api",
  };
  emitDomainEventToRealtime(record);
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
  const eventData = event.eventType.startsWith("workspaces.")
    ? projectWorkspaceRealtimeData(event.data)
    : event.data;
  const payloadData = {
    ...eventData,
    subjectId: event.subjectId,
    subjectType: event.subjectType,
    userId: event.userId,
    eventType: event.eventType,
    // Phase 0 — actor on the wire + agent-run telemetry. Sourced from the event
    // row's real columns (undefined for non-agent events; never crashes legacy
    // events). The full telemetry block lets the `agent_run:updated` socket
    // event carry cost/usage without re-querying.
    isAgent: event.isAgent,
    agentUserId: event.agentUserId,
    agentType: event.agentType,
    model: event.model,
    provider: event.provider,
    costUsd: event.costUsd,
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    tokensTotal: event.tokensTotal,
    latencyMs: event.latencyMs,
    toolCount: event.toolCount,
    runStatus: event.runStatus,
    finishReason: event.finishReason,
  } as Record<string, unknown>;
  // So frontend can invalidate documents.get({ documentId })
  if (event.eventType.startsWith("document.")) {
    payloadData.documentId = event.subjectId;
  }
  // Unified room rule: workspaceId present → workspace room. Otherwise
  // (only reachable here when workspaceIdRequired is false, since the
  // required case already returned above) → the owner's user room, so
  // pod-wide events still reach the one client that can see them.
  const body = JSON.stringify({
    event: mapped.event,
    data: payloadData,
    ...(workspaceId ? { workspaceId } : { userId: event.userId }),
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

/**
 * Normalize both legacy flat workspace events and the current wrapped event
 * shape, then apply the client-safe settings projection again at the network
 * boundary. The second projection is deliberate defense-in-depth for
 * historical events and non-repository producers.
 */
function projectWorkspaceRealtimeData(
  data: Record<string, unknown>
): Record<string, unknown> {
  const nested = data.workspace;
  const workspace =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : data;
  return {
    workspace: projectWorkspaceSettings(workspace),
  };
}
