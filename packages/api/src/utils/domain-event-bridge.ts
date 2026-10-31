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
 *   (entity.restore.completed → entity:updated)
 * - entity.transition.completed → entity:updated (a status move — the status
 *   door's one event; `lifecycle-transition.ts` appends it through the hooked
 *   repository, once per move)
 * - view.*.completed → view:created | view:updated | view:deleted
 * - workspaces.update.completed → workspace:updated
 * - relation.*.completed → relation:created | relation:updated | relation:deleted
 * - document.*.completed → document:created | document:updated | document:deleted
 * - workspaceMembers.add.completed → workspace:member_added
 * - workspaceMembers.remove.completed → workspace:member_removed
 * - widget_definition.*.completed → widget_definition:changed
 * - (focus sessions are NOT bridged here: `focus_session:updated` has ONE
 *   producer, the DB-trigger listener in `session-changed-listener.ts`)
 * - (every transition, goals' and sessions' too, ALSO becomes
 *   `status:transition:completed` per reader — not here: its audience is
 *   statusOf's floor, not a room (`services/status/status-realtime.ts`))
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
import { bridgeRequestHeaders } from "./chat-realtime-broadcast.js";
import { entityToWire } from "../routers/hub-protocol/rest/_codecs/entity.js";
// The realtime server's own check (`/bridge/emit` answers 400 on a miss).
// Subpath: no boss/db side effects.
import { validateEmitPayload } from "@synap/events/realtime-schemas";

const logger = createLogger({ module: "domain-event-bridge" });

function getRealtimeUrl(): string {
  return process.env.REALTIME_URL || "http://localhost:4001";
}

/** Map backend eventType to Socket.IO event name and whether we have workspaceId for targeting. */
function mapToSocketEvent(
  eventType: string
): { event: string; workspaceIdRequired: boolean } | null {
  const m: Record<string, { event: string; workspaceIdRequired: boolean }> = {
    // Entities are pod-wide-capable (workspaceId NULL = visible in every
    // workspace). Per the unified room rule, a NULL-workspace entity falls back
    // to the owner's `user:<ownerUserId>` room instead of being DROPPED — so
    // pod-wide entities (the bridge-discovered person/company, the pod-wide
    // bridge model) still push realtime. This MUST be `false`: with `true` the
    // guard at emitDomainEventToRealtime (workspaceIdRequired && !workspaceId)
    // silently skipped every pod-wide entity emit — the "pod-wide = no realtime"
    // gap. Workspace-scoped entities are unaffected (they carry a workspaceId →
    // still route to workspace:<id>). Mirrors entity_facet.* below.
    "entity.create.completed": {
      event: EventNames.ENTITY_CREATED,
      workspaceIdRequired: false,
    },
    "entity.update.completed": {
      event: EventNames.ENTITY_UPDATED,
      workspaceIdRequired: false,
    },
    "entity.delete.completed": {
      event: EventNames.ENTITY_DELETED,
      workspaceIdRequired: false,
    },
    // `entities.restore` clears `deletedAt`: the row changed and is listed
    // again, which clients read as an update of that entity.
    "entity.restore.completed": {
      event: EventNames.ENTITY_UPDATED,
      workspaceIdRequired: false,
    },
    // A status move (kind or role) changes the entity clients show. Goals'
    // and sessions' transitions are not bridged: no client listens for them.
    "entity.transition.completed": {
      event: EventNames.ENTITY_UPDATED,
      workspaceIdRequired: false,
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

  const eventData = event.eventType.startsWith("workspaces.")
    ? projectWorkspaceRealtimeData(event.data)
    : event.eventType.startsWith("entity.")
      ? projectEntityRealtimeData(event)
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
  // A payload the realtime server would refuse is not sent: a pod-wide
  // entity (no workspace) fails the schema on every write, and a refused POST
  // plus its warning each time says nothing new.
  const valid = validateEmitPayload(mapped.event, payloadData);
  if (!valid.ok) {
    logger.debug(
      { eventType: event.eventType, socketEvent: mapped.event },
      "Skipping bridge emit: the realtime schema refuses this payload"
    );
    return;
  }
  const body = JSON.stringify({
    event: mapped.event,
    data: payloadData,
    ...(workspaceId ? { workspaceId } : { userId: event.userId }),
  });

  postToBridge(body, { eventType: event.eventType, socketEvent: mapped.event });
}

/** POST one body to the bridge; a refusal (401/4xx/5xx) is logged, not swallowed. */
export function postToBridge(body: string, ctx: Record<string, unknown>): void {
  fetch(`${getRealtimeUrl()}/bridge/emit`, {
    method: "POST",
    headers: bridgeRequestHeaders(),
    body,
  })
    .then((res) => {
      if (!res.ok) {
        logger.warn(
          { ...ctx, status: res.status },
          "Domain event bridge: realtime refused the emit"
        );
      }
    })
    .catch((err) => {
      logger.warn(
        { ...ctx, err },
        "Domain event bridge: failed to emit to realtime"
      );
    });
}

/**
 * An entity event as the payload the realtime server validates
 * (`entity{Created,Updated,Deleted}Schema`, @synap/events/realtime-schemas —
 * `/bridge/emit` answers 400 otherwise): `entityId`, the actor
 * (`createdBy` / `updatedBy` / `deletedBy`) and the time (the event's).
 * The row a repository emits names none of them (`base-repository.ts`
 * `emitCompleted`), so before this projection every repository `entity:*`
 * push was refused.
 *
 * `changes` is what the clients patch onto the cached entity's TOP level
 * (`useRealtimeSync` `buildMerged`, the browser's `useLiveDataInvalidation`):
 *   - an update that carries the whole row (the repository's) → the fields of
 *     it the API returns as they are, through the API's own entity codec
 *     (`entityToWire`, the one `entities.get` uses), never its timestamps;
 *   - a STATUS MOVE (the transition) → nothing: a status lives in its columns,
 *     `properties[slug]` or a role's facet, so `changes` is empty and
 *     `facetChange` names the move, which makes the client refetch the
 *     entity and its graph;
 *   - anything else (the media copy's announcement) → empty: it carries its
 *     own `reason`, which the client reads first.
 * A pod-wide entity (`workspaceId: null`) still fails the schema, which
 * requires a workspace, so its push is not sent (see the check before the
 * POST); pinned by the tests.
 */
function projectEntityRealtimeData(
  event: EventRecord
): Record<string, unknown> {
  const d = event.data;
  const at = new Date(event.timestamp).toISOString();
  // WHO wrote it: the agent for an agent's write, the person otherwise.
  const actor = event.agentUserId ?? event.userId;
  const base = {
    ...d,
    entityId: d.entityId ?? d.id ?? event.subjectId,
    // The row's own counter when the event carries the row (create, update);
    // absent otherwise (a delete, a status move, the media announcement).
    version: typeof d.version === "number" ? d.version : undefined,
  };
  switch (event.eventType) {
    case "entity.create.completed":
      return {
        ...base,
        title: d.title ?? "",
        createdBy: actor,
        createdAt: typeof d.createdAt === "string" ? d.createdAt : at,
      };
    case "entity.delete.completed":
      return { ...base, deletedBy: actor, deletedAt: at };
    case "entity.transition.completed":
      return {
        ...base,
        changes: {},
        facetChange: {
          property: d.property,
          from: d.from,
          to: d.to,
          role: d.role ?? null,
        },
        updatedBy: (d.agentUserId as string | null) ?? event.userId,
        updatedAt: at,
      };
    default:
      return {
        ...base,
        changes: d.changes ?? entityRowChanges(d),
        updatedBy: actor,
        // The row's write time when the event carries it, else the event's.
        updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : at,
      };
  }
}

/**
 * The top-level fields of a whole entity row the client may patch, as the API
 * returns them. An update can change the kind (`profileSlug`, entity
 * repository) and the space, so those travel too.
 */
function entityRowChanges(
  row: Record<string, unknown>
): Record<string, unknown> {
  if (typeof row.type !== "string" || !isRecord(row.properties)) return {};
  const wire = entityToWire(row);
  return {
    type: wire.type,
    profileSlug: wire.profileSlug,
    profileId: row.profileId ?? null,
    workspaceId: wire.workspaceId,
    title: wire.title,
    preview: wire.preview,
    documentId: wire.documentId,
    properties: wire.properties,
    systemData: wire.systemData,
    ...("status" in row ? { status: row.status } : {}),
    ...("statusCategory" in row ? { statusCategory: row.statusCategory } : {}),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
